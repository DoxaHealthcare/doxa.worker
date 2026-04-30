// custom-types.d.ts
import { Request } from 'express'

declare module 'express-serve-static-core' {
  interface Request {
    id?: string
    role?: "PATIENT" | "DOCTOR"
    channelRoles?: string[]
  }
}

// Type definitions for OTP and Patient data
export interface PatientData {
   uid: string
  fullName: string
  preferredName: string
  email: string
  profileImage: string | null
  emailVerification: boolean
  emailVerifiedAt: string
  phoneNumber: string
  dateofbirth: string
  gender: string
  height: number
  heightUnit: string
  weight: number
  weightUnit: string
  verifyLater: boolean
  updateProfileLater: boolean
  occupation?: string
  mobilenumber?: string
  ethnicity?:string,
  houseAddress?:string,
  maritalStatus?:string,
  religion?:string
}

export interface DoctorData {
  uid: string
  userId: string
  fullName: string
  email: string
  endbooking: number
  ethnicity: string
  experience: string
  gender: string
  graduation: string
  houseAddress: string
  language: string
  location: string
  maritalStatus: string
  doxaEmail: string
  profileImage: string | null
  specialty?: string
  dateofbirth?: string | null
  yearOfExperience: string | null
  phoneNumber?: string | null
  availableSlots?: AvailabilityData | null
  consultationFee?: number | null
  sessionDuration?: string | null
  careerDetails?:  {
    specialty?: string | null
  } | null
}

export interface OTPData {
  otp: string
  email: string
  expiresAt: string
  attempts: number
  verified: boolean
  createdAt: string
  verifiedAt?: string
}

declare module 'node-schedule' {
  export interface Job {
    cancel(): boolean
  }
  export function scheduleJob(
    date: Date,
    callback: (fireDate: Date) => void
  ): Job
}
