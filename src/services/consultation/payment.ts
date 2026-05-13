import logger from '../../utils/logger.js'
import { getAdminFirestore } from '../../utils/firebase/admin.js'
import {
  updateDBAdmin
} from '../../utils/firebase/admin-database.js'
import { ServiceResponse } from '../../../custom-types.js'

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
  async approveInitializedPaymentToDoctorWallet (
    consultationId: string,
    doctorId: string,
    patientId: string,
    walletTransactionId?: string
  ): Promise<ServiceResponse> {
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
        return { 
          success: false, 
          message: 'Wallet transaction not found or not pending',
          code: 404,
          error: 'NOT_FOUND'
        }
      }

      const txData = (txDoc as any).data() as WalletTransactionData
      if (txData.status !== 'PENDING') {
        logger.info('approvePayment: Wallet transaction already processed', {
          consultationId,
          doctorId,
          walletTransactionId: (txDoc as any).id,
          status: txData.status
        })
        return { 
          success: true, 
          data: { walletTransactionId: (txDoc as any).id },
          message: 'Already processed',
          code: 200
        }
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
        return { 
          success: false, 
          message: 'Doctor wallet not activated',
          code: 400,
          error: 'WALLET_NOT_ACTIVATED'
        }
      }

      // Atomically credit wallet and mark transaction completed
      await db.runTransaction(async (trx: any) => {
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
        data: {
          walletTransactionId: (txDoc as any).id,
          amount,
          doctorId,
          patientId,
          consultationId
        },
        message: 'Payment approved successfully',
        code: 200
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
        message: 'Failed to approve wallet transaction',
        code: 500,
        error
      }
    }
  }

  async rejectInitializedPaymentToDoctorWallet (
    consultationId: string,
    doctorId: string,
    patientId: string,
    walletTransactionId?: string,
    reason?: string
  ): Promise<ServiceResponse> {
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
        return { 
          success: false, 
          message: 'Wallet transaction not found or not pending',
          code: 404,
          error: 'NOT_FOUND'
        }
      }

      const txData = (txDoc as any).data() as WalletTransactionData
      if (txData.status !== 'PENDING') {
        logger.info('rejectPayment: Wallet transaction already processed', {
          consultationId,
          doctorId,
          walletTransactionId: (txDoc as any).id,
          status: txData.status
        })
        return { 
          success: true, 
          data: { walletTransactionId: (txDoc as any).id },
          message: 'Already processed',
          code: 200
        }
      }

      // Mark transaction as failed/rejected. No wallet balance change since it was pending.
      const update = {
        status: 'FAILED' as const, // Standardizing to FAILED instead of REJECTED if preferred, or keep as is
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
        data: {
          walletTransactionId: (txDoc as any).id,
          doctorId,
          patientId,
          consultationId,
          status: 'REJECTED'
        },
        message: 'Payment rejected successfully',
        code: 200
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
        message: 'Failed to reject wallet transaction',
        code: 500,
        error
      }
    }
  }
}

export const consultationPaymentService = new ConsultationPaymentService()
