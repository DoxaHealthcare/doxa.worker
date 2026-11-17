import type { ApprovalPayload, WithdrawalApprovalPayload, DoctorApplicationPayload } from './types.js'
import { sendApprovalPrompt, sendWithdrawalApprovalPrompt, sendDoctorApplicationPrompt } from './prompts.js'
import {
  registerApprovalButtonsHandler,
  registerDoctorOnboardingHandler,
  registerPharmacyOnboardingHandler
} from './handlers.js'
import { discordClient } from '../../../discord/index.js'
import { TextChannel } from 'discord.js'
import { getAdminFirestore } from '../../utils/firebase/admin.js'
import { updateDBAdmin } from '../../utils/firebase/admin-database.js'
import logger from '../../utils/logger.js'

export class DiscordBotService {
  /**
   * Resolves a text channel from the cache, falling back to an API fetch when
   * the channel has not been cached yet (Discord.js only caches channels once
   * guild data has loaded, so a cache miss is not a definitive "not found").
   */
  private async getTextChannel(
    channelId: string | undefined,
    label: string
  ): Promise<TextChannel | null> {
    const id = channelId?.trim()
    if (!id) {
      logger.error(`Channel id not configured for ${label}`)
      return null
    }

    try {
      const cached = discordClient.channels.cache.get(id)
      const channel = cached ?? (await discordClient.channels.fetch(id))
      if (channel && channel.isTextBased()) return channel as TextChannel

      logger.error(`Channel not text-capable or not found for ${label}`, {
        channelId: id
      })
      return null
    } catch (err: any) {
      logger.error(`Failed to resolve channel for ${label}`, {
        channelId: id,
        error: err?.message || err
      })
      return null
    }
  }

  async notifyNewConsultation(data: { name: string; doctorName: string; date: string }) {
    const channel = await this.getTextChannel(
      process.env.DISCORD_NEW_CONSULTATION_CHANNEL_ID,
      'new consultation message'
    )
    if (!channel) return

    return channel
      .send(
        `${data.name} just scheduled a consultation with ${data.doctorName ? `Dr. ${data.doctorName}` : 'a doctor'} on ${data.date}. 🥳`
      )
      .catch((err: any) => logger.error('Failed to send message:', err))
  }

  async notifyNewUser(data: { name: string }) {
    const channel = await this.getTextChannel(
      process.env.DISCORD_NEW_USER_CHANNEL_ID,
      'new user message'
    )
    if (!channel) return

    return channel
      .send(`Welcome ${data.name} to Doxa! 🥳`)
      .catch((err: any) => logger.error('Failed to send message:', err))
  }

  async sendApprovalPrompt(
    channelId: string,
    content: string,
    payload: ApprovalPayload
  ) {
    return sendApprovalPrompt(channelId, content, payload)
  }

  async sendWithdrawalApprovalPrompt(
    content: string,
    payload: WithdrawalApprovalPayload
  ) {
    const channelId = process.env.DISCORD_WALLET_WITHDRAWAL_CHANNEL_ID?.trim()

    if (channelId)
      return sendWithdrawalApprovalPrompt(channelId, content, payload)
    else return null
  }

  async sendLogMessage(content: string) {
    const channel = await this.getTextChannel(
      process.env.DISCORD_LOGS_CHANNEL_ID,
      'logs message'
    )
    if (!channel) return

    return channel
      .send(content)
      .catch((err: any) => logger.error('Failed to send log message:', err))
  }

  async sendDoctorApplicationNotification(payload: DoctorApplicationPayload) {
    return sendDoctorApplicationPrompt(payload)
  }



  registerApprovalButtonsHandler() {
    return registerApprovalButtonsHandler()
  }

  registerDoctorOnboardingHandler() {
    return registerDoctorOnboardingHandler()
  }

  registerPharmacyOnboardingHandler() {
    return registerPharmacyOnboardingHandler()
  }

  listenToDiscordTasks() {
    const db = getAdminFirestore()
    logger.info('Starting Discord task listener')

    return db.collection('discord-tasks')
      .where('status', '==', 'PENDING')
      .onSnapshot(snapshot => {
        snapshot.docChanges().forEach(async change => {
          if (change.type === 'added') {
            const task = change.doc.data()
            const taskId = change.doc.id

            try {
              logger.info(`Processing Discord task: ${task.type}`, { taskId })

              switch (task.type) {
                case 'NOTIFY_NEW_CONSULTATION':
                  await this.notifyNewConsultation(task.payload)
                  break
                case 'NOTIFY_NEW_USER':
                  await this.notifyNewUser(task.payload)
                  break
                case 'SEND_APPROVAL_PROMPT':
                  await this.sendApprovalPrompt(task.payload.channelId, task.payload.content, task.payload.payload)
                  break
                case 'SEND_WITHDRAWAL_APPROVAL_PROMPT':
                  await this.sendWithdrawalApprovalPrompt(task.payload.content, task.payload.payload)
                  break
                case 'SEND_LOG_MESSAGE':
                  await this.sendLogMessage(task.payload.content)
                  break
                case 'SEND_DOCTOR_APPLICATION_NOTIFICATION':
                  await this.sendDoctorApplicationNotification(task.payload)
                  break
                default:
                  throw new Error(`Unknown Discord task type: ${task.type}`)
              }

              await updateDBAdmin('discord-tasks', taskId, {
                status: 'COMPLETED',
                processedAt: new Date().toISOString()
              })
            } catch (error) {
              logger.error(`Failed to process Discord task: ${task.type}`, { taskId, error })
              await updateDBAdmin('discord-tasks', taskId, {
                status: 'FAILED',
                error: (error as Error).message,
                processedAt: new Date().toISOString()
              })
            }
          }
        })
      })
  }
}

export const discordBotService = new DiscordBotService()
