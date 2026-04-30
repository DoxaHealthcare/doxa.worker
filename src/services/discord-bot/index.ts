import type { ApprovalPayload, WithdrawalApprovalPayload } from './types.js'
import { sendApprovalPrompt, sendWithdrawalApprovalPrompt } from './prompts.js'
import { registerApprovalButtonsHandler, registerDoctorOnboardingHandler } from './handlers.js'
import { discordClient } from '../../../discord/index.js'
import { ChannelType, TextChannel } from 'discord.js'
import { getAdminFirestore } from '../../utils/firebase/admin.js'
import { updateDBAdmin } from '../../utils/firebase/admin-database.js'
import logger from '../../utils/logger.js'

export class DiscordBotService {
  async notifyNewConsultation(data: { name: string; doctorName: string; date: string }) {
    const channelId = process.env.DISCORD_NEW_CONSULTATION_CHANNEL_ID
    const channel = channelId ? discordClient.channels.cache.get(channelId) : null
    if (channel && channel.type === ChannelType.GuildText) {
      const textChannel = channel as TextChannel
      return textChannel
        .send(
          `${data.name} just scheduled a consultation with Dr. ${data.doctorName} on ${data.date}. 🥳`
        )
        .catch((err: any) => logger.error('Failed to send message:', err))
    } else {
      logger.error(
        'Channel not text-capable or not found for new consultation message.'
      )
    }
  }

  async sendApprovalPrompt (
    channelId: string,
    content: string,
    payload: ApprovalPayload
  ) {
    return sendApprovalPrompt(channelId, content, payload)
  }

  async sendWithdrawalApprovalPrompt (
    content: string,
    payload: WithdrawalApprovalPayload
  ) {
    const channelId = process.env.DISCORD_WALLET_WITHDRAWAL_CHANNEL_ID

    if (channelId)
      return sendWithdrawalApprovalPrompt(channelId, content, payload)
    else return null
  }

  async sendLogMessage (content: string) {
    const channelId = process.env.DISCORD_LOGS_CHANNEL_ID
    const channel = channelId ? discordClient.channels.cache.get(channelId) : null
    if (channel && channel.type === ChannelType.GuildText) {
      const textChannel = channel as TextChannel
      return textChannel
        .send(content)
        .catch((err: any) => logger.error('Failed to send log message:', err))
    } else {
      logger.error(
        'Channel not text-capable or not found for logs message.'
      )
    }
  }

  

  registerApprovalButtonsHandler () {
    return registerApprovalButtonsHandler()
  }

  registerDoctorOnboardingHandler () {
    return registerDoctorOnboardingHandler()
  }

  listenToDiscordTasks() {
    const db = getAdminFirestore()
    logger.info('Starting Discord task listener')
    
    db.collection('discord-tasks')
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
                case 'SEND_APPROVAL_PROMPT':
                  await this.sendApprovalPrompt(task.payload.channelId, task.payload.content, task.payload.payload)
                  break
                case 'SEND_WITHDRAWAL_APPROVAL_PROMPT':
                  await this.sendWithdrawalApprovalPrompt(task.payload.content, task.payload.payload)
                  break
                case 'SEND_LOG_MESSAGE':
                  await this.sendLogMessage(task.payload.content)
                  break
                default:
                  logger.warn(`Unknown Discord task type: ${task.type}`, { taskId })
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
