import { getAdminFirestore } from '../../utils/firebase/admin.js'
import type { ApprovalTokenData, ApprovalPayload, WithdrawalApprovalPayload } from './types.js'

export async function createApprovalToken(data: ApprovalTokenData): Promise<string> {
  const adminDb = await getAdminFirestore()
  const doc = await adminDb.collection('discord-approval-tokens').add(data)
  return doc.id
}

export function buildCustomId(action: 'approve' | 'reject', tokenId?: string): string {
  return tokenId ? `${action}|${tokenId}` : action
}

export function parseCustomId(customId: string): { action: 'approve' | 'reject'; tokenId?: string } {
  const [action, tokenId] = customId.split('|')
  return { action: action as 'approve' | 'reject', tokenId }
}

export function isWithdrawalPayload(payload: ApprovalPayload | WithdrawalApprovalPayload): payload is WithdrawalApprovalPayload {
  return (payload as WithdrawalApprovalPayload).withdrawalId !== undefined
}