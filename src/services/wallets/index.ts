import { getDBAdmin, updateDBAdmin, createDBAdmin } from '../../utils/firebase/admin-database.js'
import logger from '../../utils/logger.js'
import { v4 as uuidv4 } from 'uuid'

export class WalletService {
  async updateBalance (
    doctorId: string,
    amount: number,
    type: 'CREDIT' | 'DEBIT',
    opts?: { source?: string; referenceId?: string; note?: string }
  ): Promise<{ success: boolean; message?: string; balance?: number; journalId?: string }> {
    const requestId = Math.random().toString(36).substring(7)
    try {
      if (!doctorId || typeof doctorId !== 'string') {
        logger.warn('WalletService.updateBalance: Invalid doctorId', { requestId, doctorId })
        return { success: false, message: 'Invalid doctorId' }
      }
      if (typeof amount !== 'number' || isNaN(amount) || amount <= 0) {
        logger.warn('WalletService.updateBalance: Invalid amount', { requestId, amount })
        return { success: false, message: 'Invalid amount' }
      }

      const walletRes = await getDBAdmin('wallets', doctorId)
      if (!walletRes.success || !walletRes.data) {
        logger.warn('WalletService.updateBalance: Wallet not found', { requestId, doctorId })
        return { success: false, message: `Wallet not found: ${doctorId}` }
      }

      const currentBalance = Number(walletRes.data.balance ?? 0)
      const newBalance = type === 'CREDIT'
        ? currentBalance + Number(amount)
        : currentBalance - Number(amount)

      await updateDBAdmin('wallets', doctorId, {
        balance: newBalance,
        updatedAt: new Date().toISOString()
      })

      // Write journal entry
      const journalId = uuidv4()
      try {
        await createDBAdmin('wallets_journal', journalId, {
          doctorId,
          type,
          amount,
          previousBalance: currentBalance,
          newBalance,
          source: opts?.source ?? 'system',
          referenceId: opts?.referenceId ?? null,
          note: opts?.note ?? null,
          createdAt: new Date().toISOString()
        })
      } catch (e) {
        logger.warn('WalletService.updateBalance: Failed to write journal entry', {
          requestId,
          doctorId,
          journalId,
          error: (e as any)?.message || e
        })
      }

      logger.info('WalletService.updateBalance: Balance updated', {
        requestId,
        doctorId,
        type,
        amount,
        previousBalance: currentBalance,
        newBalance,
        journalId
      })
      return { success: true, balance: newBalance, journalId }
    } catch (error: any) {
      logger.error('WalletService.updateBalance: Error updating balance', {
        requestId,
        doctorId,
        amount,
        type,
        error: error?.message || error
      })
      return { success: false, message: 'System error updating wallet balance' }
    }
  }
}

export const walletService = new WalletService()