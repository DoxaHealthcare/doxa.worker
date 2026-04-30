import { v4 as uuidv4 } from 'uuid'
import { createDBAdmin, updateDBAdmin, getDBAdmin } from '../../utils/firebase/admin-database.js'
import logger from '../../utils/logger.js'
import { walletService } from '../wallets/index.js'

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

      // Verify record exists
      const record = await getDBAdmin('withdrawals', withdrawalId)
      if (!record.success || !record.data) {
        logger.warn('WithdrawalService.approveWithdrawal: Withdrawal not found', {
          requestId,
          withdrawalId
        })
        return { success: false, message: 'Withdrawal not found' }
      }
      if (record.data.status !== 'PROCESSING' && record.data.status !== 'PENDING') {
        logger.warn('WithdrawalService.approveWithdrawal: Withdrawal not in PROCESSING or PENDING state', {
          requestId,
          withdrawalId
        })
        return { success: false, message: 'Withdrawal not in PROCESSING or PENDING state' }
      }

      logger.info('WithdrawalService.approveWithdrawal: Marking withdrawal as APPROVED', {
        requestId,
        withdrawalId,
        approvedBy: opts?.approvedBy
      })
      // Deduct withdrawal amount from doctor's wallet balance using wallet service
      const doctorId = record.data.doctorId
      const amount = record.data.amount
      const { success, message } = await walletService.updateBalance(doctorId, amount, 'DEBIT')
      if (!success) {
        throw new Error(message || 'Failed to update wallet balance')
      }
  
      await updateDBAdmin('withdrawals', withdrawalId, {
        status: 'PAID',
        approvedAt: new Date().toISOString(),
        approvedBy: opts?.approvedBy || null,
        approvalNote: opts?.note || null,
        updatedAt: new Date().toISOString(),
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
