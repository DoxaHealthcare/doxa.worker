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

export type DoctorApplicationPayload = {
  doctorId: string
  email?: string | null
  fullName?: string | null
  phoneNumber?: string | null
  specialty?: string | null
  mdcnRegistrationNumber?: string | null
  appliedAt?: string | null
  heading?: string
}

export type ApprovalTokenData = {
  kind?: 'CONSULTATION_PAYOUT' | 'WITHDRAWAL' | 'DOCTOR_APPLICATION'
  payload: ApprovalPayload | WithdrawalApprovalPayload | DoctorApplicationPayload
  status: 'PENDING' | 'APPROVED' | 'REJECTED'
  createdAt: string
  processedAt?: string
  processedBy?: string
  channelId?: string
  messageId?: string
}