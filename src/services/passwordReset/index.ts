import { randomBytes } from 'crypto'
import { createRedisConnection } from '../../utils/redis.js'

const redis = createRedisConnection('password-reset')
const TOKEN_EXPIRY_SECONDS = 3600

export class PasswordResetService {
  async generateResetLink(userId: string): Promise<string> {
    const resetToken = randomBytes(32).toString('hex')
    await redis.setex(`password-reset:${resetToken}`, TOKEN_EXPIRY_SECONDS, userId)

    const frontendBaseUrl = process.env.FRONTEND_BASE_URL
    if (!frontendBaseUrl) {
      throw new Error('FRONTEND_BASE_URL is not set')
    }
    let resetLink: string
    try {
      const u = new URL(`${frontendBaseUrl}/confirm-reset-password`)
      u.searchParams.set('token', resetToken)
      resetLink = u.toString()
    } catch (e) {
      resetLink = `${frontendBaseUrl}/confirm-reset-password?token=${resetToken}`
    }

    return resetLink
  }
}

export const passwordResetService = new PasswordResetService()
