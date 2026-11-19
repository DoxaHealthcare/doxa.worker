import { getAdminFirestore } from '../firebase/admin.js'
import { updateDBAdmin } from '../firebase/admin-database.js'
import { sendEmail } from '../../services/emailService.js'
import { discordBotService } from '../../services/discord-bot/index.js'
import { formatDoctorName } from '../formatDoctorName.js'
import { sendDoctorNotification } from '../notifications.js'
import logger from '../logger.js'

// Consultation statuses that represent a scheduled appointment that has not
// started yet. Booked consultations are created as PENDING and become UPCOMING
// once accepted by the doctor (legacy flows use ACCEPTED).
const REMINDER_STATUSES = ['PENDING', 'UPCOMING', 'ACCEPTED']

// Africa/Lagos (WAT) is UTC+1 year-round with no DST, so local time minus the
// offset gives the UTC instant. Consultation date/time are stored in this zone.
const LAGOS_OFFSET_MS = 60 * 60 * 1000
const MINUTE_MS = 60 * 1000

// Ignore consultations whose start time is older than this (stale/leftover docs)
const STALE_AFTER_MS = 60 * MINUTE_MS

// First reminder window: start is between 15 and 60 minutes away
const FIRST_REMINDER_MAX_MS = 60 * MINUTE_MS
// Final reminder window: start is 15 minutes away or already overdue
const FINAL_REMINDER_MAX_MS = 15 * MINUTE_MS

/**
 * Computes the consultation start instant (UTC ms) from its stored date
 * (`YYYY-MM-DD`) and time (`HH:mm`) values, which are in Africa/Lagos.
 */
const getConsultationStartMs = (date: string, time: string): number | null => {
  if (!date || !time) return null
  const parsed = Date.parse(`${date}T${time}:00Z`)
  if (!Number.isFinite(parsed)) return null
  return parsed - LAGOS_OFFSET_MS
}

const buildReminderCopy = (
  msUntilStart: number
): { flag: 'startReminder60mSentAt' | 'startReminder15mSentAt'; label: string } => {
  if (msUntilStart <= FINAL_REMINDER_MAX_MS) {
    return {
      flag: 'startReminder15mSentAt',
      label: msUntilStart <= 0 ? 'is due now' : 'starts in about 15 minutes'
    }
  }
  return {
    flag: 'startReminder60mSentAt',
    label: 'starts in about 1 hour'
  }
}

export const processConsultationStartReminders = async (): Promise<void> => {
  try {
    const db = getAdminFirestore()
    const now = Date.now()
    const frontendBaseUrl = (process.env.FRONTEND_BASE_URL || 'https://doxahealth.ng').replace(/\/$/, '')
    const consultationDashboardLink = `${frontendBaseUrl}/doctor/consultations`

    logger.info('Running consultation start reminder check...')

    const snapshot = await db
      .collection('consultations')
      .where('active', '==', true)
      .where('status', 'in', REMINDER_STATUSES)
      .get()

    if (snapshot.empty) {
      logger.info('No active scheduled consultations found')
      return
    }

    for (const doc of snapshot.docs) {
      const consultation = doc.data() as any
      const consultationId = doc.id

      // Some legacy docs store the schedule under scheduledDate/scheduledTime
      const consultationDate = consultation?.date || consultation?.scheduledDate
      const consultationTime = consultation?.time || consultation?.scheduledTime

      const startMs = getConsultationStartMs(consultationDate, consultationTime)
      if (startMs === null) continue

      const msUntilStart = startMs - now

      // Already too far in the past and still not started — skip leftover docs
      if (msUntilStart < -STALE_AFTER_MS) continue

      // Not yet within the first reminder window
      if (msUntilStart > FIRST_REMINDER_MAX_MS) continue

      const { flag, label } = buildReminderCopy(msUntilStart)
      const alreadySent =
        flag === 'startReminder60mSentAt'
          ? consultation?.startReminder60mSentAt
          : consultation?.startReminder15mSentAt

      if (alreadySent) continue

      const doctorId = consultation?.doctorId
      const patientId = consultation?.patientId
      if (!doctorId || !patientId) continue

      try {
        const [doctorDoc, patientDoc] = await Promise.all([
          db.collection('doctors').doc(doctorId).get(),
          db.collection('patients').doc(patientId).get()
        ])

        const doctorInfo = (doctorDoc.data() as any) || {}
        const patientInfo = (patientDoc.data() as any) || {}

        const doctorEmail = String(doctorInfo?.email || doctorInfo?.doxaEmail || '').trim()
        const doctorName = formatDoctorName(doctorInfo?.fullName, { fallback: 'Doctor' })
        const patientName =
          patientInfo?.fullName || patientInfo?.preferredName || 'your patient'
        const date = consultationDate || ''
        const time = consultationTime || ''

        if (doctorEmail) {
          await sendEmail(
            doctorEmail,
            `Reminder: your consultation ${label}`,
            'doctor-consultation-reminder',
            {
              doctorName,
              patientName,
              date,
              time,
              timezone: 'WAT',
              consultationId,
              reminderLabel: label,
              consultationDashboardLink
            },
            'consultation'
          )
        } else {
          logger.warn('Consultation reminder: doctor email not available', {
            consultationId,
            doctorId
          })
        }

        await sendDoctorNotification(doctorId, {
          title: 'Upcoming consultation',
          body: `Your consultation with ${patientName} ${label}.`,
          data: { type: 'consultation-start-reminder', consultationId }
        })

        await updateDBAdmin('consultations', consultationId, {
          [flag]: new Date().toISOString()
        }).catch(() => {})

        await discordBotService.sendLogMessage(
          `⏰ **[Consultation Reminder] Doctor Notified (${label})**\n` +
          `• **Doctor:** ${doctorName}${doctorEmail ? ` (<${doctorEmail}>)` : ''}\n` +
          `• **Patient:** ${patientName}\n` +
          `• **Consultation ID:** \`${consultationId}\`\n` +
          `• **Status:** Reminded to start the scheduled consultation.`
        ).catch(() => {})

        logger.info('Consultation start reminder sent', {
          consultationId,
          doctorId,
          reminder: flag
        })
      } catch (err: any) {
        logger.error('Failed to send consultation start reminder', {
          consultationId,
          error: err?.message || err
        })
      }
    }

    logger.info('Consultation start reminder check completed')
  } catch (error: any) {
    logger.error('Error in processConsultationStartReminders:', {
      error: error?.message || error
    })
  }
}
