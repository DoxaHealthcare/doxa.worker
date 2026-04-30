export type ApprovalPayload = {
  consultationId: string
  patientId: string
  doctorId: string
  walletTransactionId?: string
  amount?: number
}

export type WithdrawalApprovalPayload = {
  withdrawalId: string
  doctorId: string
  amount?: number
  walletBalance?: number
  bankName?: string
  accountNumber?: string
  accountName?: string
}

export type ApprovalTokenData = {
  kind?: 'CONSULTATION_PAYOUT' | 'WITHDRAWAL'
  payload: ApprovalPayload | WithdrawalApprovalPayload
  status: 'PENDING' | 'APPROVED' | 'REJECTED'
  createdAt: string
  processedAt?: string
  processedBy?: string
  channelId?: string
  messageId?: string
}