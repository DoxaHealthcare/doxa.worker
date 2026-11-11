import 'dotenv/config'
import { getAdminFirestore, initializeFirebaseAdmin } from '../src/utils/firebase/admin.js'
import { processDoctorInviteFollowUps } from '../src/utils/scheduler/doctorInviteFollowUp.js'
import { processPatientRetentionFollowUps } from '../src/utils/scheduler/patientRetentionFollowUp.js'
import logger from '../src/utils/logger.js'

/**
 * Script to run initial/catch-up email dispatch & expiry cleanup
 * for existing users and doctors on the Doxa platform.
 *
 * Usage:
 *   npx tsx scripts/runInitialFollowUpCampaign.ts [--dry-run]
 */

const isDryRun = process.argv.includes('--dry-run')

async function runInitialCampaign() {
  console.log(`\n======================================================`)
  console.log(`🚀 Starting Doxa Initial Email & Retention Catch-Up Run`)
  console.log(`Mode: ${isDryRun ? 'DRY-RUN (No actual emails/deletions)' : 'LIVE EXECUTION'}`)
  console.log(`======================================================\n`)

  try {
    initializeFirebaseAdmin()
    const db = getAdminFirestore()

    console.log(`📊 Checking existing database stats before execution...`)
    const [pendingInvitesSnap, patientsSnap] = await Promise.all([
      db.collection('doctor-invites').where('status', '==', 'PENDING').get(),
      db.collection('patients').get()
    ])

    console.log(`• Pending Doctor Invites in database: ${pendingInvitesSnap.size}`)
    console.log(`• Total Patients in database: ${patientsSnap.size}\n`)

    if (isDryRun) {
      console.log(`[Dry Run] Simulating Doctor Invite Scan:`)
      const now = Date.now()
      const ONE_DAY = 24 * 60 * 60 * 1000
      const THREE_DAYS = 3 * ONE_DAY

      for (const doc of pendingInvitesSnap.docs) {
        const data = doc.data()
        const createdAt = data.createdAt ? new Date(data.createdAt).getTime() : 0
        const expiresAt = data.expiresAt ? new Date(data.expiresAt).getTime() : 0
        const email = data.email || doc.id

        if (expiresAt > 0 && now > expiresAt) {
          console.log(`  - [EXPIRED -> WOULD SEND EXPIRY EMAIL & DELETE] Invite: ${email} (Expired at: ${data.expiresAt})`)
        } else if (expiresAt > 0 && expiresAt - now <= ONE_DAY && !data.expiryWarningSentAt) {
          console.log(`  - [EXPIRING SOON -> WOULD WARN] Invite: ${email} (Expires in: ${Math.round((expiresAt - now)/3600000)}h)`)
        } else if (createdAt > 0 && now - createdAt >= THREE_DAYS && !data.reminder3dSentAt) {
          console.log(`  - [3-DAY OLD -> WOULD REMIND] Invite: ${email}`)
        } else if (createdAt > 0 && now - createdAt >= ONE_DAY && !data.reminder24hSentAt) {
          console.log(`  - [24-HOUR OLD -> WOULD REMIND] Invite: ${email}`)
        }
      }

      console.log(`\n[Dry Run] Simulating Patient Retention Scan:`)
      for (const doc of patientsSnap.docs) {
        const patient = doc.data()
        const isVerified = patient.emailVerification === true
        const email = patient.email || doc.id

        if (!isVerified && !patient.verificationReminderSentAt) {
          console.log(`  - [UNVERIFIED -> WOULD REMIND EMAIL VERIFICATION] Patient: ${email}`)
        } else if (isVerified && !patient.firstBookingPromptSentAt) {
          // Check bookings
          const bookings = await db.collection('consultations').where('patientId', '==', doc.id).limit(1).get()
          if (bookings.empty) {
            console.log(`  - [VERIFIED 0 BOOKINGS -> WOULD SEND 1st CONSULTATION PROMPT] Patient: ${email}`)
          }
        }
      }

      console.log(`\n✨ Dry run complete. Run without --dry-run to execute live.`)
      process.exit(0)
    }

    // LIVE RUN
    console.log(`1️⃣ Processing Doctor Invite Follow-Ups & Expired Details Cleanup...`)
    await processDoctorInviteFollowUps()

    console.log(`\n2️⃣ Processing Patient Email Verification & First Booking Prompts...`)
    await processPatientRetentionFollowUps()

    console.log(`\n✅ Finished initial campaign catch-up for all existing platform users!\n`)
    process.exit(0)
  } catch (error: any) {
    logger.error('Failed to run initial campaign:', error)
    console.error('❌ Error during run:', error?.message || error)
    process.exit(1)
  }
}

runInitialCampaign()
