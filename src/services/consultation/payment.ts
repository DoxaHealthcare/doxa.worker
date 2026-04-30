import { v4 as uuidv4 } from 'uuid'
import logger from '../../utils/logger.js'
import { getAdminFirestore } from '../../utils/firebase/admin.js'
import {
  getDBAdmin,
  createDBAdmin,
  updateDBAdmin
} from '../../utils/firebase/admin-database.js'
import { chargesService } from '../chargesService.js'
import type { DoctorData } from '../../../custom-types.js'

interface WalletTransactionData {
  id: string
  doctorId: string
  patientId: string
  consultationId: string
  consultationTransactionId?: string
  amount: number
  currency: string
  status: 'PENDING' | 'COMPLETED' | 'FAILED'
  type: string
  createdAt: string
  updatedAt: string
}

export class ConsultationPaymentService {
  async initializePaymentToDoctorWallet (
    consultationId: string,
    doctorId: string,
    patientId: string,
    overrideAmount?: number,
    currencyOverride?: string
  ) {
    try {
      const db = getAdminFirestore()
      const timestamp = new Date().toISOString()

      let payoutAmount = 0
      let currency = 'NGN'
      let consultationTransactionId = ''

      // Try to fetch the related consultation transaction to get accurate fee breakdown
      const txQuery = await db
        .collection('consultation-transactions')
        .where('consultationId', '==', consultationId)
        .limit(1)
        .get()

      if (!txQuery.empty) {
        const txDoc = txQuery.docs[0]
        const txData = txDoc.data() as any
        consultationTransactionId = txDoc.id
        payoutAmount = Number(txData?.consultationFee || 0)
        currency = currencyOverride || txData?.currency || 'NGN'
      } else {
        // Fallback: compute payout from the doctor's configured consultation fee
        const doctorRecord = await getDBAdmin('doctors', doctorId)
        const doctorInfo = doctorRecord?.data as DoctorData
        const rawFee = Number(doctorInfo?.consultationFee || 0)
        const calc = chargesService.calculateConsultationFee(rawFee)
        payoutAmount = Number(calc.consultationFee || 0)
        currency = currencyOverride || 'NGN'
      }

      // Allow explicit override of computed amount
      if (typeof overrideAmount === 'number' && !Number.isNaN(overrideAmount)) {
        payoutAmount = overrideAmount
      }

      const walletTransactionId = uuidv4()
      const walletTransaction: WalletTransactionData = {
        id: walletTransactionId,
        doctorId,
        patientId,
        consultationId,
        consultationTransactionId,
        amount: payoutAmount,
        currency,
        status: 'PENDING',
        type: 'CONSULTATION_EARNINGS',
        createdAt: timestamp,
        updatedAt: timestamp
      }

      await createDBAdmin(
        'wallets-transactions',
        walletTransactionId,
        walletTransaction
      )

      logger.info('consultationSuccessful: Wallet transaction initialized (PENDING)', {
        consultationId,
        doctorId,
        walletTransactionId,
        amount: payoutAmount
      })
      return {
        success: true,
        walletTransactionId,
        data: walletTransaction
      }
    } catch (walletError) {
      logger.error(
        'consultationSuccessful: Failed to initialize wallet transaction',
        {
          consultationId,
          doctorId,
          error: walletError
        }
      )
      // Non-blocking: do not fail the consultation endpoint if wallet init fails
      return {
        success: false,
        error: walletError instanceof Error ? walletError.message : walletError
      }
    }
  }

  async approveInitializedPaymentToDoctorWallet (
    consultationId: string,
    doctorId: string,
    patientId: string,
    walletTransactionId?: string
  ) {
    const db = getAdminFirestore()
    const timestamp = new Date().toISOString()

    try {
      // Locate the wallet transaction
      let txDoc: FirebaseFirestore.QueryDocumentSnapshot | FirebaseFirestore.DocumentSnapshot | null = null
      if (walletTransactionId) {
        const direct = await db.collection('wallets-transactions').doc(walletTransactionId).get()
        txDoc = direct.exists ? direct : null
      } else {
        const query = await db
          .collection('wallets-transactions')
          .where('consultationId', '==', consultationId)
          .where('doctorId', '==', doctorId)
          .where('status', '==', 'PENDING')
          .limit(1)
          .get()
        txDoc = query.empty ? null : query.docs[0]
      }

      if (!txDoc) {
        logger.warn('approvePayment: Wallet transaction not found or not pending', {
          consultationId,
          doctorId,
          walletTransactionId
        })
        return { success: false, error: 'Wallet transaction not found or not pending' }
      }

      const txData = (txDoc as any).data() as WalletTransactionData
      if (txData.status !== 'PENDING') {
        logger.info('approvePayment: Wallet transaction already processed', {
          consultationId,
          doctorId,
          walletTransactionId: (txDoc as any).id,
          status: txData.status
        })
        return { success: true, message: 'Already processed', walletTransactionId: (txDoc as any).id }
      }

      const amount = Number(txData.amount || 0)
      const walletRef = db.collection('wallets').doc(doctorId)
      const walletTxRef = db.collection('wallets-transactions').doc((txDoc as any).id)

      // Ensure doctor wallet exists
      const walletSnap = await walletRef.get()
      if (!walletSnap.exists) {
        logger.warn('approvePayment: Doctor wallet not activated', {
          consultationId,
          doctorId
        })
        return { success: false, error: 'Doctor wallet not activated' }
      }

      // Atomically credit wallet and mark transaction completed
      await db.runTransaction(async (trx) => {
        const freshWalletSnap = await trx.get(walletRef)
        const currentBalance = Number(freshWalletSnap.data()?.balance || 0)
        const newBalance = currentBalance + amount

        trx.update(walletRef, { balance: newBalance, updatedAt: timestamp })
        trx.update(walletTxRef, { status: 'COMPLETED', completedAt: timestamp, updatedAt: timestamp })
      })

      logger.info('approvePayment: Wallet credited and transaction completed', {
        consultationId,
        doctorId,
        walletTransactionId: (txDoc as any).id,
        amount
      })

      return {
        success: true,
        walletTransactionId: (txDoc as any).id,
        amount,
        doctorId,
        patientId,
        consultationId
      }
    } catch (error: any) {
      logger.error('approvePayment: Failed to approve wallet transaction', {
        consultationId,
        doctorId,
        walletTransactionId,
        error: error?.message || error
      })
      return {
        success: false,
        error: error?.message || 'Failed to approve wallet transaction'
      }
    }
  }

  async rejectInitializedPaymentToDoctorWallet (
    consultationId: string,
    doctorId: string,
    patientId: string,
    walletTransactionId?: string,
    reason?: string
  ) {
    const db = getAdminFirestore()
    const timestamp = new Date().toISOString()

    try {
      // Locate the wallet transaction
      let txDoc: FirebaseFirestore.QueryDocumentSnapshot | FirebaseFirestore.DocumentSnapshot | null = null
      if (walletTransactionId) {
        const direct = await db.collection('wallets-transactions').doc(walletTransactionId).get()
        txDoc = direct.exists ? direct : null
      } else {
        const query = await db
          .collection('wallets-transactions')
          .where('consultationId', '==', consultationId)
          .where('doctorId', '==', doctorId)
          .where('status', '==', 'PENDING')
          .limit(1)
          .get()
        txDoc = query.empty ? null : query.docs[0]
      }

      if (!txDoc) {
        logger.warn('rejectPayment: Wallet transaction not found or not pending', {
          consultationId,
          doctorId,
          walletTransactionId
        })
        return { success: false, error: 'Wallet transaction not found or not pending' }
      }

      const txData = (txDoc as any).data() as WalletTransactionData
      if (txData.status !== 'PENDING') {
        logger.info('rejectPayment: Wallet transaction already processed', {
          consultationId,
          doctorId,
          walletTransactionId: (txDoc as any).id,
          status: txData.status
        })
        return { success: true, message: 'Already processed', walletTransactionId: (txDoc as any).id }
      }

      // Mark transaction as failed/rejected. No wallet balance change since it was pending.
      const update = {
        status: 'REJECTED' as const,
        rejectReason: reason || 'Rejected',
        rejectedAt: timestamp,
        updatedAt: timestamp
      }


      await updateDBAdmin('wallets-transactions', (txDoc as any).id, update)

      logger.info('rejectPayment: Wallet transaction marked as REJECTED', {
        consultationId,
        doctorId,
        walletTransactionId: (txDoc as any).id,
        reason: update.rejectReason
      })

      return {
        success: true,
        walletTransactionId: (txDoc as any).id,
        doctorId,
        patientId,
        consultationId,
        status: 'REJECTED'
      }
    } catch (error: any) {
      logger.error('rejectPayment: Failed to reject wallet transaction', {
        consultationId,
        doctorId,
        walletTransactionId,
        error: error?.message || error
      })
      return {
        success: false,
        error: error?.message || 'Failed to reject wallet transaction'
      }
    }
  }
}

export const consultationPaymentService = new ConsultationPaymentService()
