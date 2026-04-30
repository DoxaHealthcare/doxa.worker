import { getAdminFirestore } from '../firebase/admin.js'
import { updateDBAdmin } from '../firebase/admin-database.js'
import logger from '../logger.js'
import { sendEmail as sendTemplateEmail } from '../../services/emailService.js'

export const sendPendingConsultationPaymentReminder = async (
  transactionId: string,
  options?: { force?: boolean }
): Promise<void> => {
  try {
    if (!transactionId || typeof transactionId !== 'string') {
      logger.warn(
        'sendPendingConsultationPaymentReminder: Invalid transactionId',
        {
          transactionId
        }
      )
      return
    }

    const db = getAdminFirestore()
    const txDoc = await db
      .collection('consultation-transactions')
      .doc(transactionId)
      .get()

    if (!txDoc.exists) {
      logger.warn('Payment reminder: transaction not found, skipping', {
        transactionId
      })
      return
    }

    const txData = txDoc.data() as any
    const status = (txData?.status || '').toUpperCase()

    if (status !== 'PENDING' && !options?.force) {
      logger.info('Payment reminder: status no longer pending', {
        transactionId,
        status
      })
      return
    }

    const patientId = txData?.patientId
    const doctorId = txData?.doctorId
    const patientDoc = await db.collection('patients').doc(patientId).get()
    const doctorDoc = await db.collection('doctors').doc(doctorId).get()

    const patientInfo = (patientDoc.data() as any) || {}
    const doctorInfo = (doctorDoc.data() as any) || {}
    const patientEmail = patientInfo?.email || ''
    const doctorName = doctorInfo?.fullName || 'your doctor'

    if (!patientEmail) {
      logger.warn('Payment reminder: patient email not available', {
        transactionId,
        patientId
      })
      return
    }

    const firstName =
      (patientInfo?.fullName || '')?.split(' ')[0] ||
      patientInfo?.firstName ||
      ''
    const virtualAccountNumber =
      txData?.virtualAccountData?.virtualBankAccountNumber || ''
    const virtualBankCode = txData?.virtualAccountData?.virtualBankCode || ''
    const date = txData?.consultationDetails?.date || ''
    const time = txData?.consultationDetails?.time || ''
    const amount = (txData?.amount || '')?.toString()
    const frontend = process.env.FRONTEND_BASE_URL || 'https://doxahealth.ng'
    const paymentDashboardLink = `${frontend}/patient/consultations`

    await sendTemplateEmail(
      patientEmail,
      'Payment Reminder: Complete Your Consultation',
      'pending-consultation-patient-reminder',
      {
        firstName,
        doctorName,
        date,
        time,
        timezone: 'WAT',
        transactionId: transactionId as string,
        virtualAccountNumber,
        virtualBankCode,
        virtualBank: 'Wema Bank',
        amount,
        paymentDashboardLink
      }
    )

    logger.info('Payment reminder email sent', {
      transactionId,
      patientId,
      email: patientEmail.replace(/(.{2}).*(@.*)/, '$1***$2')
    })

    await updateDBAdmin('consultation-transactions', transactionId, {
      pendingReminderSentAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }).catch(() => {})
  } catch (error: any) {
    logger.error(
      'sendPendingConsultationPaymentReminder: Failed to send reminder',
      {
        transactionId,
        error: error?.message || error
      }
    )
  }
}
