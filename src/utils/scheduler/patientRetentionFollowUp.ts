import { getAdminFirestore } from '../firebase/admin.js'
import { updateDBAdmin } from '../firebase/admin-database.js'
import { sendEmail } from '../../services/emailService.js'
import { discordBotService } from '../../services/discord-bot/index.js'
import logger from '../logger.js'

export const processPatientRetentionFollowUps = async (): Promise<void> => {
  try {
    const db = getAdminFirestore()
    const now = Date.now()
    const frontendBaseUrl = (process.env.FRONTEND_BASE_URL || 'https://doxahealth.ng').replace(/\/$/, '')

    logger.info('Running patient retention and verification follow-up check...')

    const ONE_HOUR = 60 * 60 * 1000
    const ONE_DAY = 24 * ONE_HOUR
    const THREE_DAYS = 3 * ONE_DAY
    const FOURTEEN_DAYS = 14 * ONE_DAY

    // Query patients created within the last 14 days
    const minCreatedDate = new Date(now - FOURTEEN_DAYS).toISOString()
    const snapshot = await db
      .collection('patients')
      .where('createdAt', '>=', minCreatedDate)
      .get()

    if (snapshot.empty) {
      logger.info('No recently registered patients found for retention checks')
      return
    }

    logger.info(`Checking ${snapshot.size} recently registered patients...`)

    for (const doc of snapshot.docs) {
      const patient = doc.data() as any
      const patientId = doc.id
      const email = patient.email
      const fullName = patient.fullName || patient.preferredName || 'there'

      if (!email) continue

      const createdAt = patient.createdAt ? new Date(patient.createdAt).getTime() : 0
      if (!createdAt) continue

      const timeSinceSignup = now - createdAt

      // -------------------------------------------------------------
      // Flow 1: Unverified Email (Exactly 24 hours after sign-up)
      // -------------------------------------------------------------
      const isVerified = patient.emailVerification === true
      if (!isVerified) {
        // Send after 24 hours (with a 2-hour grace window) to preserve sign-up time-of-day
        if (timeSinceSignup >= ONE_DAY && !patient.verificationReminderSentAt) {
          logger.info('Sending 24-hour verification reminder to patient', { patientId, email })
          const verifyUrl = `${frontendBaseUrl}/patient/signin`

          await sendEmail(
            email,
            'Please verify your Doxa Healthcare account',
            'patient-verify-reminder',
            {
              fullName,
              verifyUrl,
              subject: 'Please verify your Doxa Healthcare account'
            },
            'onboarding'
          )

          await updateDBAdmin('patients', patientId, {
            verificationReminderSentAt: new Date().toISOString()
          })

          await discordBotService.sendLogMessage(
            `📧 **[Patient Retention] 24-Hour Email Verification Reminder**\n` +
            `• **Patient:** ${fullName} (<${email}>)\n` +
            `• **Patient ID:** \`${patientId}\`\n` +
            `• **Status:** Reminded to verify unconfirmed account.`
          ).catch(() => {})
        }
        // If unverified, don't ask to book doctor yet
        continue
      }

      // -------------------------------------------------------------
      // Flow 2: Verified, but never booked a doctor (Day 3 follow-up)
      // -------------------------------------------------------------
      if (
        timeSinceSignup >= THREE_DAYS &&
        !patient.firstBookingPromptSentAt
      ) {
        // Check if patient has any consultations booked
        const consultationSnap = await db
          .collection('consultations')
          .where('patientId', '==', patientId)
          .limit(1)
          .get()

        if (consultationSnap.empty) {
          logger.info('Sending first-booking prompt to verified patient without bookings', {
            patientId,
            email
          })
          const bookDoctorUrl = `${frontendBaseUrl}/doctors`

          await sendEmail(
            email,
            'Speak with a licensed doctor today on Doxa',
            'patient-first-booking-prompt',
            {
              fullName,
              bookDoctorUrl,
              subject: 'Speak with a licensed doctor today on Doxa'
            },
            'support'
          )

          await updateDBAdmin('patients', patientId, {
            firstBookingPromptSentAt: new Date().toISOString()
          })

          await discordBotService.sendLogMessage(
            `🚀 **[Patient Activation] Day 3 First Consultation Prompt**\n` +
            `• **Patient:** ${fullName} (<${email}>)\n` +
            `• **Patient ID:** \`${patientId}\`\n` +
            `• **Status:** Verified user has zero bookings; prompted to find/book a doctor.`
          ).catch(() => {})
        }
      }
    }

    logger.info('Patient retention and verification follow-up check completed')
  } catch (error: any) {
    logger.error('Error in processPatientRetentionFollowUps:', { error: error?.message || error })
  }
}
