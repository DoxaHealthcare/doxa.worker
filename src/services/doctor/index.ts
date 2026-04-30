import { getAuth } from 'firebase-admin/auth'
import {
  getAdminFirestore,
  initializeFirebaseAdmin
} from '../../utils/firebase/admin.js'
import logger from '../../utils/logger.js'
import { sendEmail } from '../emailService.js'

type DoctorOnboardInput = {
  email: string
  password: string
  fullName?: string
}

type ServiceResult<T = any> = {
  success: boolean
  message: string
  data?: T | null
  error?: string
}

export class DoctorService {
  async onboardDoctor (
    doctor: DoctorOnboardInput
  ): Promise<
    ServiceResult<{ doctorId: string; email: string; fullName: string }>
  > {
    try {
      const { email: doctorEmail, password, fullName } = doctor

      const email = doctorEmail.toLowerCase().trim()
      if (!email || !password) {
        return {
          success: false,
          message: 'Email and password are required',
          error: 'VALIDATION_ERROR'
        }
      }

      initializeFirebaseAdmin()
      const auth = getAuth()

      // Create auth user
      let userRecord: any
      try {
        userRecord = await auth.createUser({
          email,
          password,
          displayName: fullName || undefined
        })
      } catch (err: any) {
        logger.error(
          'DoctorService.onboardDoctor: Failed to create auth user',
          {
            email,
            error: err?.message || err
          }
        )

        const message =
          err?.code === 'auth/email-already-exists'
            ? 'A user with this email already exists'
            : 'Failed to create doctor user'

        return {
          success: false,
          message,
          error: err?.message || String(err)
        }
      }

      // Create Firestore doctor profile
      const db = getAdminFirestore()
      const now = new Date().toISOString()
      const doctorId = userRecord.uid

      const doctorProfile = {
        uid: doctorId,
        email,
        fullName: fullName || '',
        createdAt: now,
        updatedAt: now,
        doxaEmail: email
      }

      const doctorWallet = {
        doctorId,
        createdAt: now,
        updatedAt: now,
        balance: 0
      }

      try {
        await db.collection('doctors').doc(doctorId).set(doctorProfile)
        await db.collection('wallets').doc(doctorId).set(doctorWallet)
      } catch (err: any) {
        logger.error('DoctorService.onboardDoctor: Failed to save profile', {
          doctorId,
          email,
          error: err?.message || err
        })
        return {
          success: false,
          message: 'Failed to save doctor profile',
          error: err?.message || String(err)
        }
      }

      const targetEmail = email
      const doctorName = (fullName || 'Doctor').trim()

      let resetLink: string = await auth.generatePasswordResetLink(targetEmail)

      await sendEmail(
        targetEmail,
        'Welcome to Doxa Healthcare — Doctor Onboarding',
        'onboarded-doctor',
        {
          fullName: doctorName,
          resetLink
        },
        'onboarding'
      )

      logger.info(
        'DoctorService.onboardDoctor: Doctor onboarded successfully',
        {
          doctorId,
          email: email.replace(/(.{2}).*(@.*)/, '$1***$2')
        }
      )

      return {
        success: true,
        message: 'Doctor onboarded successfully',
        data: { doctorId, email, fullName: fullName as string }
      }
    } catch (error: any) {
      logger.error('DoctorService.onboardDoctor: Unexpected error', {
        error: error?.message || error
      })
      return {
        success: false,
        message: 'Unexpected error',
        error: error?.message || String(error)
      }
    }
  }
}

export const doctorService = new DoctorService()
