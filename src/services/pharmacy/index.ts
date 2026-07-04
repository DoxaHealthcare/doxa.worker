import { getAuth } from 'firebase-admin/auth'
import {
  getAdminFirestore,
  initializeFirebaseAdmin
} from '../../utils/firebase/admin.js'
import logger from '../../utils/logger.js'
import { sendEmail } from '../emailService.js'
import { passwordResetService } from '../passwordReset/index.js'

type PharmacyOnboardInput = {
  email: string
  password: string
  fullName: string
  pharmacyName: string
  licenseNumber: string
  phoneNumber: string
  address?: string
  location?: string
}

type ServiceResult<T = any> = {
  success: boolean
  message: string
  data?: T | null
  error?: string
}

export class PharmacyService {
  async onboardPharmacy(
    pharmacy: PharmacyOnboardInput
  ): Promise<
    ServiceResult<{
      pharmacyId: string
      email: string
      fullName: string
      pharmacyName: string
    }>
  > {
    try {
      const {
        email: pharmacyEmail,
        password,
        fullName,
        pharmacyName,
        licenseNumber,
        phoneNumber,
        address = '',
        location = ''
      } = pharmacy

      const email = pharmacyEmail.toLowerCase().trim()
      if (!email || !password || !fullName || !pharmacyName || !licenseNumber || !phoneNumber) {
        return {
          success: false,
          message: 'Email, password, fullName, pharmacyName, licenseNumber, and phoneNumber are required',
          error: 'VALIDATION_ERROR'
        }
      }

      initializeFirebaseAdmin()
      const auth = getAuth()

      let userRecord: any
      try {
        userRecord = await auth.createUser({
          email,
          password,
          displayName: fullName
        })
      } catch (err: any) {
        logger.error('PharmacyService.onboardPharmacy: Failed to create auth user', {
          email,
          error: err?.message || err
        })

        const message =
          err?.code === 'auth/email-already-exists'
            ? 'A user with this email already exists'
            : 'Failed to create pharmacy user'

        return {
          success: false,
          message,
          error: err?.message || String(err)
        }
      }

      const db = getAdminFirestore()
      const now = new Date().toISOString()
      const pharmacyId = userRecord.uid

      const pharmacyProfile = {
        uid: pharmacyId,
        email,
        fullName,
        pharmacyName,
        licenseNumber,
        phoneNumber,
        address,
        location,
        profileImage: null,
        createdAt: now,
        updatedAt: now
      }

      try {
        await db.collection('pharmacies').doc(pharmacyId).set(pharmacyProfile)
      } catch (err: any) {
        logger.error('PharmacyService.onboardPharmacy: Failed to save profile', {
          pharmacyId,
          email,
          error: err?.message || err
        })
        return {
          success: false,
          message: 'Failed to save pharmacy profile',
          error: err?.message || String(err)
        }
      }

      const resetLink = await passwordResetService.generateResetLink(pharmacyId)

      await sendEmail(
        email,
        'Welcome to Doxa Healthcare — Pharmacy Onboarding',
        'onboarded-pharmacy',
        {
          fullName,
          pharmacyName,
          resetLink
        },
        'onboarding'
      )

      logger.info('PharmacyService.onboardPharmacy: Pharmacy onboarded successfully', {
        pharmacyId,
        email: email.replace(/(.{2}).*(@.*)/, '$1***$2')
      })

      return {
        success: true,
        message: 'Pharmacy onboarded successfully',
        data: { pharmacyId, email, fullName, pharmacyName }
      }
    } catch (error: any) {
      logger.error('PharmacyService.onboardPharmacy: Unexpected error', {
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

export const pharmacyService = new PharmacyService()
