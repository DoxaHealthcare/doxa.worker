import { getAdminFirestore } from '../firebase/admin.js'
import { updateDBAdmin } from '../firebase/admin-database.js'
import { sendEmail } from '../../services/emailService.js'
import { discordBotService } from '../../services/discord-bot/index.js'
import logger from '../logger.js'

export const processDoctorInviteFollowUps = async (): Promise<void> => {
  try {
    const db = getAdminFirestore()
    const now = Date.now()
    const frontendBaseUrl = (process.env.FRONTEND_BASE_URL || 'https://doxahealth.ng').replace(/\/$/, '')

    logger.info('Running doctor invite follow-up check...')

    // Query pending doctor invites
    const snapshot = await db
      .collection('doctor-invites')
      .where('status', '==', 'PENDING')
      .get()

    if (snapshot.empty) {
      logger.info('No pending doctor invites found')
      return
    }

    const ONE_HOUR = 60 * 60 * 1000
    const ONE_DAY = 24 * ONE_HOUR
    const THREE_DAYS = 3 * ONE_DAY

    for (const doc of snapshot.docs) {
      const invite = doc.data() as any
      const inviteId = doc.id
      const email = invite.email
      const fullName = invite.fullName || 'Doctor'
      const token = invite.token || inviteId

      if (!email) continue

      const createdAt = invite.createdAt ? new Date(invite.createdAt).getTime() : 0
      const expiresAt = invite.expiresAt ? new Date(invite.expiresAt).getTime() : 0
      const onboardUrl = `${frontendBaseUrl}/become-a-doctor?token=${encodeURIComponent(token)}`

      // 1. Follow-up 1: 24 Hours after invite was sent (at the same time of day)
      // Check window: between 24h and 48h after creation, if reminder_24h not sent
      if (
        createdAt > 0 &&
        now - createdAt >= ONE_DAY &&
        now - createdAt < THREE_DAYS &&
        !invite.reminder24hSentAt
      ) {
        logger.info('Sending 24-hour reminder to invited doctor', { inviteId, email })
        await sendEmail(
          email,
          'Reminder: Complete your Doxa Doctor profile',
          'doctor-invite-reminder',
          {
            fullName,
            onboardUrl,
            subject: 'Reminder: Complete your Doxa Doctor profile'
          },
          'onboarding'
        )

        await updateDBAdmin('doctor-invites', inviteId, {
          reminder24hSentAt: new Date().toISOString()
        })

        await discordBotService.sendLogMessage(
          `📧 **[Doctor Follow-Up] 24-Hour Profile Reminder Sent**\n` +
          `• **Doctor:** Dr. ${fullName} (<${email}>)\n` +
          `• **Invite ID:** \`${inviteId}\`\n` +
          `• **Status:** Reminded to complete profile and set consultation fees.`
        ).catch(() => {})
        continue
      }

      // 2. Follow-up 2: 3 Days after invite was sent
      // Check window: after 3 days, if reminder_3d not sent
      if (
        createdAt > 0 &&
        now - createdAt >= THREE_DAYS &&
        !invite.reminder3dSentAt
      ) {
        logger.info('Sending 3-day reminder to invited doctor', { inviteId, email })
        await sendEmail(
          email,
          'Dr. ' + fullName + ', your Doxa profile is waiting for you',
          'doctor-invite-reminder',
          {
            fullName,
            onboardUrl,
            subject: 'Your Doxa profile is waiting for you'
          },
          'onboarding'
        )

        await updateDBAdmin('doctor-invites', inviteId, {
          reminder3dSentAt: new Date().toISOString()
        })

        await discordBotService.sendLogMessage(
          `📧 **[Doctor Follow-Up] Day 3 Profile Reminder Sent**\n` +
          `• **Doctor:** Dr. ${fullName} (<${email}>)\n` +
          `• **Invite ID:** \`${inviteId}\`\n` +
          `• **Status:** Reminded that profile is awaiting completion.`
        ).catch(() => {})
        continue
      }

      // 3. Expiry Warning: 24 Hours (or less) remaining before expiration
      if (
        expiresAt > 0 &&
        expiresAt > now &&
        expiresAt - now <= ONE_DAY &&
        !invite.expiryWarningSentAt
      ) {
        const hoursLeft = Math.max(1, Math.round((expiresAt - now) / ONE_HOUR))
        const timeLeft = hoursLeft > 1 ? `${hoursLeft} hours` : '1 hour'

        logger.info('Sending expiry warning to invited doctor', { inviteId, email, timeLeft })
        await sendEmail(
          email,
          `Action Required: Your Doxa invitation link expires in ${timeLeft}`,
          'doctor-invite-expiring',
          {
            fullName,
            onboardUrl,
            timeLeft,
            subject: `Action Required: Your Doxa invitation link expires in ${timeLeft}`
          },
          'onboarding'
        )

        await updateDBAdmin('doctor-invites', inviteId, {
          expiryWarningSentAt: new Date().toISOString()
        })

        await discordBotService.sendLogMessage(
          `⚠️ **[Doctor Invite Alert] Expiry Warning Sent (${timeLeft} Left)**\n` +
          `• **Doctor:** Dr. ${fullName} (<${email}>)\n` +
          `• **Invite ID:** \`${inviteId}\`\n` +
          `• **Time Remaining:** ${timeLeft}`
        ).catch(() => {})
        continue
      }

      // 4. Cleanup Expired Invites: If the link has expired and doctor hasn't completed onboarding, delete
      if (expiresAt > 0 && now > expiresAt) {
        logger.info('Invite expired without onboarding, deleting doctor invite details', {
          inviteId,
          email
        })

        // Delete the invite document from 'doctor-invites'
        await db.collection('doctor-invites').doc(inviteId).delete()

        await discordBotService.sendLogMessage(
          `🗑️ **[Doctor Invite Expired & Cleaned Up]**\n` +
          `• **Doctor Email:** <${email}>\n` +
          `• **Invite ID:** \`${inviteId}\`\n` +
          `• **Action:** Invitation token and details deleted from platform due to expiry.`
        ).catch(() => {})
      }
    }

    logger.info('Doctor invite follow-up check completed')
  } catch (error: any) {
    logger.error('Error in processDoctorInviteFollowUps:', { error: error?.message || error })
  }
}
