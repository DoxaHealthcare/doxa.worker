import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type TextChannel
} from 'discord.js'
import { discordClient } from '../../../discord/index.js'
import logger from '../../utils/logger.js'
import { getAdminFirestore } from '../../utils/firebase/admin.js'
import { createApprovalToken, buildCustomId } from './tokens.js'
import type {
  ApprovalPayload,
  ApprovalTokenData,
  WithdrawalApprovalPayload
} from './types.js'

export async function sendApprovalPrompt (
  channelId: string,
  content: string,
  payload: ApprovalPayload
) {
  const adminDb = getAdminFirestore()

  const tokenData: ApprovalTokenData = {
    kind: 'CONSULTATION_PAYOUT',
    payload,
    status: 'PENDING',
    createdAt: new Date().toISOString()
  }
  const tokenId = await createApprovalToken(tokenData)

  const embed = new EmbedBuilder()
    .setTitle('Consultation Payout Approval')
    .setDescription(content)
    .addFields([
      { name: 'Consultation ID', value: payload.consultationId, inline: true },
      { name: 'Doctor ID', value: payload.doctorId, inline: true },
      ...(payload.amount != null
        ? [{ name: 'Amount', value: `${payload.amount}`, inline: true }]
        : [])
    ])
    .setTimestamp(new Date())

  const approveId = buildCustomId('approve', tokenId)
  const rejectId = buildCustomId('reject', tokenId)
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(approveId)
      .setLabel('Approve')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(rejectId)
      .setLabel('Reject')
      .setStyle(ButtonStyle.Danger)
  )

  const channel = discordClient.channels.cache.get(channelId)

  if (!channel || !channel.isTextBased())
    throw new Error(`Discord channel not found: ${channelId}`)

  const message = await (channel as TextChannel).send({
    embeds: [embed],
    flags: MessageFlags.SuppressNotifications
  })
  await message.edit({ components: [row] })

  await adminDb
    .collection('discord-approval-tokens')
    .doc(tokenId)
    .update({ channelId, messageId: message.id })
  logger.info('Sent consultation payout approval prompt', {
    tokenId,
    channelId,
    messageId: message.id
  })

  return { tokenId, messageId: message.id }
}

export async function sendWithdrawalApprovalPrompt (
  channelId: string,
  content: string,
  payload: WithdrawalApprovalPayload
) {
  const adminDb = getAdminFirestore()

  const tokenData: ApprovalTokenData = {
    kind: 'WITHDRAWAL',
    payload,
    status: 'PENDING',
    createdAt: new Date().toISOString()
  }
  const wallet = await adminDb
    .collection('wallets')
    .doc(payload.doctorId)
    .get()
  if (!wallet.exists)
    throw new Error(`Wallet not found: ${payload.doctorId}`)
  

  const tokenId = await createApprovalToken(tokenData)

  const embed = new EmbedBuilder()
    .setTitle('Withdrawal Approval')
    .setDescription(content)
    .addFields([
      { name: 'Withdrawal ID', value: payload.withdrawalId, inline: true },
      { name: 'Doctor ID', value: payload.doctorId, inline: true },
      ...(payload.amount != null
        ? [{ name: 'Amount', value: `${payload.amount}`, inline: true }]
        : []),
      ...(wallet.data()?.balance != null
        ? [{ name: 'Wallet', value: `${wallet.data()?.balance}`, inline: true }]
        : []),
      ...(payload.bankName
        ? [{ name: 'Bank', value: payload.bankName, inline: true }]
        : []),
      ...(payload.accountName
        ? [{ name: 'Account Name', value: payload.accountName, inline: true }]
        : []),
      ...(payload.accountNumber
        ? [
            {
              name: 'Account Number',
              value: payload.accountNumber,
              inline: true
            }
          ]
        : [])
    ])
    .setTimestamp(new Date())

  const approveId = buildCustomId('approve', tokenId)
  const rejectId = buildCustomId('reject', tokenId)
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(approveId)
      .setLabel('Approve')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(rejectId)
      .setLabel('Reject')
      .setStyle(ButtonStyle.Danger)
  )

  const channel = discordClient.channels.cache.get(channelId)

  if (!channel || !channel.isTextBased())
    throw new Error(`Discord channel not found: ${channelId}`)

  const message = await (channel as any).send({
    embeds: [embed],
    flags: MessageFlags.SuppressNotifications
  })
  await message.edit({ components: [row] })

  await adminDb
    .collection('discord-approval-tokens')
    .doc(tokenId)
    .update({ channelId, messageId: message.id })
  logger.info('Sent withdrawal approval prompt', {
    tokenId,
    channelId,
    messageId: message.id
  })

  return { tokenId, messageId: message.id }
}
