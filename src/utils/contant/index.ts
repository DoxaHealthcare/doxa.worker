const domain = process.env.DOMAIN_NAME as string

export const EMAIL_FROM = process.env.EMAIL_FROM as string
export const EMAILS_FROM = {
  noreply: EMAIL_FROM,
  doctor: `doctor@${domain}`,
  patient: `patient@${domain}`,
  wallet: `wallet@${domain}`,
  system: `system@${domain}`,
  onboarding: `onboarding@${domain}`,
  consultation: `consultation@${domain}`,
  consumer: `consumer@${domain}`,
  support: `support@${domain}`
}

export type EmailFrom = keyof typeof EMAILS_FROM