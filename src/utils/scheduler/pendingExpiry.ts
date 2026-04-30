import { getAdminFirestore } from '../firebase/admin.js'
import { updateDBAdmin } from '../firebase/admin-database.js'
import logger from '../logger.js'
import { sendEmail as sendTemplateEmail } from '../../services/emailService.js'

/**
 * Expire a pending consultation transaction if still pending and notify patient.
 */
export const expirePendingConsultationTransaction = async (
  transactionId: string
): Promise<void> => {
  try {
    if (!transactionId || typeof transactionId !== 'string') {
      logger.warn('expirePendingConsultationTransaction: Invalid transactionId', {
        transactionId
      })
      return
    }

    const db = getAdminFirestore()
    const txDoc = await db
      .collection('consultation-transactions')
      .doc(transactionId)
      .get()

    if (!txDoc.exists) {
      logger.warn('Expire: transaction not found, skipping', { transactionId })
      return
    }

    const txData = txDoc.data() as any
    const status = (txData?.status || '').toUpperCase()

    if (status !== 'PENDING') {
      logger.info('Expire: status no longer pending, skipping', {
        transactionId,
        status
      })
      return
    }

    // Determine expiry timestamp from virtual account data
    const expiredAtStr = txData?.virtualAccountData?.expiredAt || txData?.virtualAccountData?.expiryTime || ''
    const expiredAt = expiredAtStr ? new Date(expiredAtStr) : null

    const now = new Date()
    const effectiveExpiredAt = expiredAt && !isNaN(expiredAt.getTime()) ? expiredAt : now

    // Mark transaction as expired
    await updateDBAdmin('consultation-transactions', transactionId, {
      status: 'EXPIRED',
      expiredAt: effectiveExpiredAt.toISOString(),
      updatedAt: new Date().toISOString()
    }).catch(() => { })

    // Notify patient with expired template
    const patientId = txData?.patientId
    const doctorId = txData?.doctorId
    const patientDoc = await db.collection('patients').doc(patientId).get()
    const doctorDoc = await db.collection('doctors').doc(doctorId).get()

    const patientInfo = (patientDoc.data() as any) || {}
    const doctorInfo = (doctorDoc.data() as any) || {}
    const patientEmail = patientInfo?.email || ''
    const doctorName = doctorInfo?.fullName || 'your doctor'

    if (!patientEmail) {
      logger.warn('Expire: patient email not available', {
        transactionId,
        patientId
      })
      return
    }

    const firstName =
      (patientInfo?.fullName || '')?.split(' ')[0] || patientInfo?.firstName || ''
    const virtualAccountNumber = txData?.virtualAccountData?.virtualBankAccountNumber || ''
    const virtualBankCode = txData?.virtualAccountData?.virtualBankCode || ''
    const date = txData?.consultationDetails?.date || ''
    const time = txData?.consultationDetails?.time || ''
    const amount = (txData?.amount || '')?.toString()
    const timezone = 'WAT'
    const frontend = process.env.FRONTEND_BASE_URL as string
    const paymentDashboardLink = `${frontend}/patient/consultations`
    const supportEmail = process.env.SUPPORT_EMAIL as string

    const expiryDate = effectiveExpiredAt.toLocaleDateString('en-NG', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    })
    const expiryTime = effectiveExpiredAt.toLocaleTimeString('en-NG', {
      hour: '2-digit',
      minute: '2-digit'
    })

    await sendTemplateEmail(
      patientEmail,
      'Payment Window Expired: Generate New Payment Details',
      'pending-consultation-patient-expired',
      {
        firstName,
        doctorName,
        date,
        time,
        timezone,
        transactionId: transactionId as string,
        virtualAccountNumber,
        virtualBankCode,
        virtualBank: 'Wema Bank',
        amount,
        paymentDashboardLink,
        supportEmail,
        expiryDate,
        expiryTime
      }
    )

    logger.info('Expired email sent and transaction marked expired', {
      transactionId,
      patientId,
      email: patientEmail.replace(/(.{2}).*(@.*)/, '$1***$2')
    })
  } catch (error: any) {
    logger.error('expirePendingConsultationTransaction: Failed to expire transaction', {
      transactionId,
      error: error?.message || error
    })
  }
}