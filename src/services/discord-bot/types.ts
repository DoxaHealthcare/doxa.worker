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
  gender?: string | null
  dateofbirth?: string | null
  specialty?: string | null
  experience?: string | null
  affiliatedHospital?: string | null
  mdcnRegistrationNumber?: string | null
  aboutMe?: string | null
  profileImage?: string | null
  consultationFee?: number | string | null
  sessionDuration?: string | null
  availableDaysSummary?: string | null
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