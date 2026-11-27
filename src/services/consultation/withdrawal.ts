import { v4 as uuidv4 } from 'uuid'
import { createDBAdmin, updateDBAdmin, getDBAdmin } from '../../utils/firebase/admin-database.js'
import { getAdminFirestore } from '../../utils/firebase/admin.js'
import logger from '../../utils/logger.js'

type InitiateWithdrawalInput = {
  doctorId: string
  amount: number
  bankName: string
  accountNumber: string
  accountName: string
}

type InitiateWithdrawalResult = {
  success: boolean
  message?: string
  withdrawalId?: string
}

export class WithdrawalService {
  async initiateWithdrawal ({
    doctorId,
    amount,
    bankName,
    accountNumber,
    accountName
  }: InitiateWithdrawalInput): Promise<InitiateWithdrawalResult> {
    const requestId = Math.random().toString(36).substring(7)
    try {
      // Basic validation
      if (!doctorId || typeof doctorId !== 'string') {
        logger.warn('WithdrawalService.initiateWithdrawal: Invalid doctorId', {
          requestId,
          doctorId
        })
        return { success: false, message: 'Invalid doctorId' }
      }
      if (!amount || typeof amount !== 'number' || amount <= 0) {
        logger.warn('WithdrawalService.initiateWithdrawal: Invalid amount', {
          requestId,
          amount
        })
        return { success: false, message: 'Invalid amount' }
      }

      const withdrawalId = uuidv4()
      const data = {
        doctorId,
        amount,
        status: 'PENDING',
        method: 'BANK_TRANSFER',
        bankName,
        accountNumber,
        accountName,
        createdAt: new Date().toISOString()
      }

      logger.info(
        'WithdrawalService.initiateWithdrawal: Creating withdrawal record',
        {
          requestId,
          withdrawalId,
          doctorId,
          amount
        }
      )

      const res = await createDBAdmin('withdrawals', withdrawalId, data)
      if (!res?.success) {
        logger.error(
          'WithdrawalService.initiateWithdrawal: Failed to create record',
          {
            requestId,
            withdrawalId
          }
        )
        return {
          success: false,
          message: 'Failed to initiate withdrawal'
        }
      }

      logger.info(
        'WithdrawalService.initiateWithdrawal: Withdrawal initiated successfully',
        {
          requestId,
          withdrawalId,
          doctorId,
          amount
        }
      )
      return {
        success: true,
        withdrawalId
      }
    } catch (error: any) {
      logger.error(
        'WithdrawalService.initiateWithdrawal: Error initiating withdrawal',
        {
          requestId,
          error: error?.message || error
        }
      )
      return {
        success: false,
        message: 'System error initiating withdrawal'
      }
    }
  }

  async markWithdrawalProcessing (withdrawalId: string): Promise<{ success: boolean; message?: string }> {
    const requestId = Math.random().toString(36).substring(7)
    try {
      if (!withdrawalId || typeof withdrawalId !== 'string') {
        logger.warn('WithdrawalService.markWithdrawalProcessing: Invalid withdrawalId', {
          requestId,
          withdrawalId
        })
        return { success: false, message: 'Invalid withdrawalId' }
      }

      // Verify record exists
      const record = await getDBAdmin('withdrawals', withdrawalId)
      if (!record.success || !record.data) {
        logger.warn('WithdrawalService.markWithdrawalProcessing: Withdrawal not found', {
          requestId,
          withdrawalId
        })
        return { success: false, message: 'Withdrawal not found' }
      }

      logger.info('WithdrawalService.markWithdrawalProcessing: Updating status to PROCESSING', {
        requestId,
        withdrawalId
      })
      await updateDBAdmin('withdrawals', withdrawalId, {
        status: 'PROCESSING',
        updatedAt: new Date().toISOString(),
        processingAt: new Date().toISOString()
      })
      return { success: true }
    } catch (error: any) {
      logger.error('WithdrawalService.markWithdrawalProcessing: Error updating status', {
        requestId,
        withdrawalId,
        error: error?.message || error
      })
      return { success: false, message: 'System error updating status' }
    }
  }

  async approveWithdrawal (
    withdrawalId: string,
    opts?: { approvedBy?: string; note?: string }
  ): Promise<{ success: boolean; message?: string }> {
    const requestId = Math.random().toString(36).substring(7)
    try {
      if (!withdrawalId || typeof withdrawalId !== 'string') {
        logger.warn('WithdrawalService.approveWithdrawal: Invalid withdrawalId', {
          requestId,
          withdrawalId
        })
        return { success: false, message: 'Invalid withdrawalId' }
      }

      const db = getAdminFirestore()
      const withdrawalRef = db.collection('withdrawals').doc(withdrawalId)
      const timestamp = new Date().toISOString()

      // Debit the doctor wallet, mark the withdrawal PAID and write a linked
      // journal entry atomically — mirrors the admin panel's handler so both
      // writers behave identically (balance check, no negative wallets).
      const outcome = await db.runTransaction(async (trx) => {
        const withdrawalSnap = await trx.get(withdrawalRef)
        if (!withdrawalSnap.exists) {
          return { ok: false as const, message: 'Withdrawal not found' }
        }

        const withdrawal = withdrawalSnap.data() || {}
        const status =
          typeof withdrawal.status === 'string'
            ? withdrawal.status.toUpperCase()
            : ''
        if (status !== 'PROCESSING' && status !== 'PENDING') {
          return {
            ok: false as const,
            message: 'Withdrawal not in PROCESSING or PENDING state'
          }
        }

        const doctorId =
          typeof withdrawal.doctorId === 'string' ? withdrawal.doctorId : ''
        const amount = Number(withdrawal.amount)
        if (!doctorId || !Number.isFinite(amount) || amount <= 0) {
          return {
            ok: false as const,
            message: 'Withdrawal has invalid doctor or amount data'
          }
        }

        const walletRef = db.collection('wallets').doc(doctorId)
        const walletSnap = await trx.get(walletRef)
        if (!walletSnap.exists) {
          return { ok: false as const, message: 'Doctor wallet not found' }
        }
        const balance = Number(walletSnap.data()?.balance ?? 0)
        if (!Number.isFinite(balance) || balance < amount) {
          return {
            ok: false as const,
            message: 'Doctor wallet balance is lower than the withdrawal amount'
          }
        }

        const newBalance = balance - amount
        const journalId = uuidv4()
        trx.update(walletRef, { balance: newBalance, updatedAt: timestamp })
        trx.update(withdrawalRef, {
          status: 'PAID',
          approvedAt: timestamp,
          approvedBy: opts?.approvedBy || null,
          approvalNote: opts?.note || null,
          updatedAt: timestamp
        })
        trx.set(db.collection('wallets_journal').doc(journalId), {
          doctorId,
          type: 'DEBIT',
          amount,
          previousBalance: balance,
          newBalance,
          source: 'withdrawal',
          referenceId: withdrawalId,
          note: 'External transfer confirmed via Discord',
          createdAt: timestamp
        })
        return { ok: true as const, balance: newBalance, journalId }
      })

      if (!outcome.ok) {
        logger.warn('WithdrawalService.approveWithdrawal: Rejected', {
          requestId,
          withdrawalId,
          message: outcome.message
        })
        return { success: false, message: outcome.message }
      }

      logger.info('WithdrawalService.approveWithdrawal: Withdrawal approved and wallet debited', {
        requestId,
        withdrawalId,
        balance: outcome.balance,
        journalId: outcome.journalId
      })
      return { success: true }
    } catch (error: any) {
      logger.error('WithdrawalService.approveWithdrawal: Error approving withdrawal', {
        requestId,
        withdrawalId,
        error: error?.message || error
      })
      return { success: false, message: 'System error approving withdrawal' }
    }
  }

  async rejectWithdrawal (
    withdrawalId: string,
    opts?: { rejectedBy?: string; reason?: string }
  ): Promise<{ success: boolean; message?: string }> {
    const requestId = Math.random().toString(36).substring(7)
    try {
      if (!withdrawalId || typeof withdrawalId !== 'string') {
        logger.warn('WithdrawalService.rejectWithdrawal: Invalid withdrawalId', {
          requestId,
          withdrawalId
        })
        return { success: false, message: 'Invalid withdrawalId' }
      }

      const record = await getDBAdmin('withdrawals', withdrawalId)
      if (!record.success || !record.data) {
        logger.warn('WithdrawalService.rejectWithdrawal: Withdrawal not found', {
          requestId,
          withdrawalId
        })
        return { success: false, message: 'Withdrawal not found' }
      }

      logger.info('WithdrawalService.rejectWithdrawal: Marking withdrawal as REJECTED', {
        requestId,
        withdrawalId,
        rejectedBy: opts?.rejectedBy
      })
      await updateDBAdmin('withdrawals', withdrawalId, {
        status: 'REJECTED',
        rejectedAt: new Date().toISOString(),
        rejectedBy: opts?.rejectedBy || null,
        rejectionReason: opts?.reason || null,
        updatedAt: new Date().toISOString()
      })
      return { success: true }
    } catch (error: any) {
      logger.error('WithdrawalService.rejectWithdrawal: Error rejecting withdrawal', {
        requestId,
        withdrawalId,
        error: error?.message || error
      })
      return { success: false, message: 'System error rejecting withdrawal' }
    }
  }
}

export const withdrawalService = new WithdrawalService()
