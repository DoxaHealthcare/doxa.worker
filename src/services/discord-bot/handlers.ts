import { MessageFlags } from 'discord.js'
import { discordClient } from '../../../discord/index.js'
import logger from '../../utils/logger.js'
import { getAdminFirestore } from '../../utils/firebase/admin.js'
import { parseCustomId } from './tokens.js'
import { consultationPaymentService } from '../consultation/payment.js'
import { withdrawalService } from '../consultation/withdrawal.js'
import { doctorService } from '../doctor/index.js'
import { pharmacyService } from '../pharmacy/index.js'
import { initializeFirebaseAdmin } from '../../utils/firebase/admin.js'
import { getAuth } from 'firebase-admin/auth'
import { sendEmail } from '../emailService.js'

type DoctorOnboardingMessage = {
  email?: string
  fullName?: string
  password?: string
}

type PharmacyOnboardingMessage = DoctorOnboardingMessage & {
  pharmacyName?: string
  licenseNumber?: string
  phoneNumber?: string
  address?: string
  location?: string
}

const extractEmail = (text: string): string | null => {
  const match = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)
  return match ? match[0] : null
}

const extractField = (text: string, key: string): string | null => {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`${escapedKey}\\s*[:=]\\s*("([^"]+)"|'([^']+)'|([^,\n]+))`, 'i')
  const m = text.match(re)
  if (!m) return null
  return (m[2] || m[3] || m[4] || '').trim()
}

const splitMessageParts = (content: string): string[] =>
  content.split(/[,\n]/).map(p => p.trim()).filter(Boolean)

const parseDoctorOnboardingMessage = (content: string): DoctorOnboardingMessage => {
  const email = extractEmail(content) || extractField(content, 'email') || undefined
  const fullName = extractField(content, 'fullname') || extractField(content, 'fullName') || extractField(content, 'name') || undefined
  const password = extractField(content, 'password') || undefined

  if (!fullName || !password) {
    const parts = splitMessageParts(content)
    if (parts.length >= 3) {
      const pEmail = email || parts.find(p => /@/.test(p))
      const idxEmail = parts.findIndex(p => p === pEmail)
      const pFullName = idxEmail >= 0 ? parts[idxEmail + 1] : undefined
      const pPassword = idxEmail >= 0 ? parts[idxEmail + 2] : undefined
      return { email: pEmail || email, fullName: pFullName || fullName, password: pPassword || password }
    }
  }

  return { email, fullName, password }
}

const parsePharmacyOnboardingMessage = (content: string): PharmacyOnboardingMessage => {
  const parsed = parseDoctorOnboardingMessage(content)
  const pharmacyName = extractField(content, 'pharmacyName') || extractField(content, 'pharmacy') || undefined
  const licenseNumber = extractField(content, 'licenseNumber') || extractField(content, 'license') || undefined
  const phoneNumber = extractField(content, 'phoneNumber') || extractField(content, 'phone') || undefined
  const address = extractField(content, 'address') || undefined
  const location = extractField(content, 'location') || undefined

  if (!pharmacyName || !licenseNumber || !phoneNumber) {
    const parts = splitMessageParts(content)
    const pEmail = parsed.email || parts.find(p => /@/.test(p))
    const idxEmail = parts.findIndex(p => p === pEmail)

    if (idxEmail >= 0 && parts.length >= idxEmail + 6) {
      return {
        email: pEmail || parsed.email,
        fullName: parsed.fullName || parts[idxEmail + 1],
        password: parsed.password || parts[idxEmail + 2],
        pharmacyName: pharmacyName || parts[idxEmail + 3],
        licenseNumber: licenseNumber || parts[idxEmail + 4],
        phoneNumber: phoneNumber || parts[idxEmail + 5],
        address: address || parts[idxEmail + 6],
        location: location || parts[idxEmail + 7]
      }
    }
  }

  return {
    ...parsed,
    pharmacyName,
    licenseNumber,
    phoneNumber,
    address,
    location
  }
}

export function registerApprovalButtonsHandler() {
  const safeRespond = async (
    interaction: any,
    content: string
  ) => {
    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.reply({ content, flags: MessageFlags.Ephemeral })
      } else {
        await interaction.editReply({ content })
      }
    } catch (err) {
      logger.error('Discord response failure', { error: (err as Error).message })
    }
  }

  discordClient.on('interactionCreate', async (interaction: any) => {
    try {
      if (!interaction.isButton()) return

      const { action, tokenId } = parseCustomId(interaction.customId)
      if (!['approve', 'reject'].includes(action)) return

      await interaction.deferReply({ ephemeral: true })

      if (!tokenId) {
        return safeRespond(interaction, 'Unknown interaction: missing token id.')
      }

      const adminDb =  getAdminFirestore()
      const tokenSnap = await adminDb.collection('discord-approval-tokens').doc(tokenId).get()
      if (!tokenSnap.exists) {
        return safeRespond(interaction, 'Unknown interaction: token not found.')
      }

      const tokenData = tokenSnap.data() || {}
      const tokenKind = tokenData.kind || 'CONSULTATION_PAYOUT'

      if (tokenKind === 'CONSULTATION_PAYOUT') {
        const p = tokenData?.payload || {}
        if (action === 'approve') {
          await consultationPaymentService.approveInitializedPaymentToDoctorWallet(
            p.consultationId,
            p.doctorId,
            p.patientId,
            p.walletTransactionId
          )
          await adminDb.collection('discord-approval-tokens').doc(tokenId).update({ status: 'APPROVED', processedAt: new Date().toISOString() })
          return safeRespond(interaction, 'Consultation payout approved.')
        } else {
          await consultationPaymentService.rejectInitializedPaymentToDoctorWallet(
            p.consultationId,
            p.doctorId,
            p.patientId,
            p.walletTransactionId,
            'Rejected via Discord'
          )
          await adminDb.collection('discord-approval-tokens').doc(tokenId).update({ status: 'REJECTED', processedAt: new Date().toISOString() })
          return safeRespond(interaction, 'Consultation payout rejected.')
        }
      }

      if (tokenKind === 'WITHDRAWAL') {
        const wid = tokenData?.payload?.withdrawalId
        if (action === 'approve') {
          const result = await withdrawalService.approveWithdrawal(wid, { approvedBy: interaction?.user?.id })
          await adminDb.collection('discord-approval-tokens').doc(tokenId).update({ status: 'APPROVED', processedAt: new Date().toISOString() })
          return safeRespond(interaction, result.message || 'Withdrawal approved.')
        } else {
          const result = await withdrawalService.rejectWithdrawal(wid, { rejectedBy: interaction?.user?.id, reason: 'Rejected via Discord' })
          await adminDb.collection('discord-approval-tokens').doc(tokenId).update({ status: 'REJECTED', processedAt: new Date().toISOString() })
          return safeRespond(interaction, result.message || 'Withdrawal rejected.')
        }
      }

      return safeRespond(interaction, 'Unknown token kind.')
    } catch (error) {
      logger.error('Error handling Discord interaction', { error: (error as Error).message })
      try {
        await safeRespond(interaction, 'An error occurred while processing your action.')
      } catch {}
    }
  })

  logger.info('Discord approval button handler registered')
}

export function registerDoctorOnboardingHandler () {
  const CHANNEL_ID = process.env.DISCORD_DOCTOR_ONBOARDING_CHANNEL_ID

  discordClient.on('messageCreate', async message => {
    try {
      if (message.author.bot) return
      if (message.channelId !== CHANNEL_ID) return

      const { email, fullName, password } = parseDoctorOnboardingMessage(message.content || '')
      if (!email || !password) {
        await message.reply('Format error: please include email and password. Example: email=user@example.com fullname="Jane Doe" password=Secr3t!')
        return
      }

      const name = (fullName || 'Doctor').trim()
      const result = await doctorService.onboardDoctor({ email, password, fullName: name })

      if (result.success) {
        // Generate reset link and send onboarding email
        try {
          initializeFirebaseAdmin()
          const auth = getAuth()
          const targetEmail = result.data?.email || email

          let resetLink: string
          const continueUrlEnv = process.env.FRONTEND_BASE_URL
          try {
            if (continueUrlEnv) {
              let continueUrl = continueUrlEnv
              try {
                const u = new URL(continueUrlEnv)
                u.searchParams.set('email', targetEmail)
                continueUrl = u.toString()
              } catch (e) {
                logger.warn('FRONTEND_BASE_URL invalid; using as-is', { FRONTEND_BASE_URL: continueUrlEnv })
              }
              resetLink = await auth.generatePasswordResetLink(targetEmail, { url: continueUrl })
            } else {
              resetLink = await auth.generatePasswordResetLink(targetEmail)
            }
          } catch (err: any) {
            if (err?.errorInfo?.code === 'auth/unauthorized-continue-uri') {
              resetLink = await auth.generatePasswordResetLink(targetEmail)
            } else {
              throw err
            }
          }

          await sendEmail(targetEmail, 'Welcome to Doxa Healthcare — Doctor Onboarding', 'onboarded-doctor', {
            fullName: name,
            resetLink
          })
        } catch (emailErr: any) {
          logger.error('Discord onboarding: Failed to send email', { error: emailErr?.message || String(emailErr) })
        }

        await message.reply(`Onboarded ✅ — ${name} (${email.replace(/(.{2}).*(@.*)/, '$1***$2')}). A password reset email has been sent.`)
      } else {
        const msg = result.message || result.error || 'Failed to onboard doctor'
        await message.reply(`Onboard failed ❌ — ${msg}`)
      }
    } catch (err: any) {
      logger.error('registerDoctorOnboardingHandler: Failed handling message', { error: err?.message || String(err) })
      try {
        await message.reply('Internal error while onboarding doctor.')
      } catch {}
    }
  })

  logger.info('Discord doctor onboarding handler registered')
}

export function registerPharmacyOnboardingHandler () {
  const CHANNEL_ID = process.env.DISCORD_PHARMACY_ONBOARDING_CHANNEL_ID

  discordClient.on('messageCreate', async message => {
    try {
      if (message.author.bot) return
      if (message.channelId !== CHANNEL_ID) return

      const {
        email,
        fullName,
        password,
        pharmacyName,
        licenseNumber,
        phoneNumber,
        address,
        location
      } = parsePharmacyOnboardingMessage(message.content || '')

      if (!email || !password || !fullName || !pharmacyName || !licenseNumber || !phoneNumber) {
        await message.reply(
          'Format error: please include email, fullName, password, pharmacyName, licenseNumber, and phoneNumber. Example: email=pharmacy@example.com fullName="Jane Doe" password=Secr3t! pharmacyName="Doxa Pharmacy" licenseNumber=PCN-123 phoneNumber=08012345678 address="12 Road" location=Lagos'
        )
        return
      }

      const result = await pharmacyService.onboardPharmacy({
        email,
        password,
        fullName,
        pharmacyName,
        licenseNumber,
        phoneNumber,
        address,
        location
      })

      if (result.success) {
        await message.reply(
          `Onboarded ✅ — ${pharmacyName} (${email.replace(/(.{2}).*(@.*)/, '$1***$2')}). A password reset email has been sent.`
        )
      } else {
        const msg = result.message || result.error || 'Failed to onboard pharmacy'
        await message.reply(`Onboard failed ❌ — ${msg}`)
      }
    } catch (err: any) {
      logger.error('registerPharmacyOnboardingHandler: Failed handling message', { error: err?.message || String(err) })
      try {
        await message.reply('Internal error while onboarding pharmacy.')
      } catch {}
    }
  })

  logger.info('Discord pharmacy onboarding handler registered', {
    channelId: CHANNEL_ID || null
  })
}
