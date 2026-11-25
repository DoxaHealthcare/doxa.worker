import logger from '../../utils/logger.js'
import { getAdminFirestore } from '../../utils/firebase/admin.js'
import { updateDBAdmin } from '../../utils/firebase/admin-database.js'
import { sendEmail } from '../../services/emailService.js'
import {
  sendPatientNotification
} from '../../utils/notifications.js'
import { formatDoctorName } from '../../utils/formatDoctorName.js'

// Consultation statuses that mean the session has finished and the patient
// can leave feedback.
const FINISHED_STATUSES = ['ENDED', 'COMPLETED', 'SUCCESSFUL']

// When the listener (re)starts, historical docs arrive as 'added' changes.
// Only prompt for consultations that ended recently so we don't spam patients
// for old appointments after a worker restart.
const RECENT_END_WINDOW_MS = 30 * 60 * 1000

const pendingRatingAggregations = new Map<string, Promise<void>>()

// Last seen status per consultation doc, used to detect transitions into a
// finished state without relying on DocumentChange.before (untyped in admin).
const lastSeenStatuses = new Map<string, string | undefined>()

const isFinishedStatus = (status: unknown): boolean =>
  typeof status === 'string' && FINISHED_STATUSES.includes(status)

const endedRecently = (endedAt: unknown): boolean => {
  if (typeof endedAt !== 'string') return false
  const endedMs = Date.parse(endedAt)
  if (!Number.isFinite(endedMs)) return false
  return Date.now() - endedMs <= RECENT_END_WINDOW_MS
}

/**
 * Recomputes a doctor's average rating (`stars`) and `reviewCount` from all
 * documents in `consultations-patient-reviews` for that doctor.
 */
const aggregateDoctorRating = async (doctorId: string): Promise<void> => {
  try {
    const db = getAdminFirestore()
    const snapshot = await db
      .collection('consultations-patient-reviews')
      .where('doctorId', '==', doctorId)
      .get()

    let total = 0
    let count = 0
    snapshot.forEach(doc => {
      const rating = Number((doc.data() as any)?.rating)
      if (Number.isFinite(rating) && rating > 0) {
        total += rating
        count += 1
      }
    })

    await updateDBAdmin('doctors', doctorId, {
      stars: count > 0 ? Math.round((total / count) * 10) / 10 : 0,
      reviewCount: count,
      ratingUpdatedAt: new Date().toISOString()
    })

    logger.info('Doctor rating aggregate updated', {
      doctorId,
      reviewCount: count,
      average: count > 0 ? total / count : 0
    })
  } catch (error: any) {
    logger.error('Failed to aggregate doctor rating', {
      doctorId,
      error: error?.message || error
    })
  }
}

const queueDoctorRatingAggregation = (doctorId: string): void => {
  if (!doctorId) return
  const existing = pendingRatingAggregations.get(doctorId)
  if (existing) return

  const promise = aggregateDoctorRating(doctorId).finally(() => {
    pendingRatingAggregations.delete(doctorId)
  })
  pendingRatingAggregations.set(doctorId, promise)
}

/**
 * Sends the post-consultation feedback prompt (email + push) to the patient.
 */
const sendFeedbackPrompt = async (
  consultationId: string,
  consultation: any
): Promise<void> => {
  const patientId = consultation?.patientId
  const doctorId = consultation?.doctorId
  if (!patientId || !doctorId) return

  const db = getAdminFirestore()
  const [patientDoc, doctorDoc] = await Promise.all([
    db.collection('patients').doc(patientId).get(),
    db.collection('doctors').doc(doctorId).get()
  ])

  const patient = (patientDoc.data() as any) || {}
  const doctor = (doctorDoc.data() as any) || {}

  const patientName =
    patient?.preferredName || patient?.fullName || 'there'
  const doctorName = formatDoctorName(doctor?.fullName, { fallback: 'Doctor' })
  const patientEmail = String(
    patient?.email || patient?.doxaEmail || ''
  ).trim()

  const frontendBaseUrl = (
    process.env.FRONTEND_BASE_URL || 'https://doxahealth.ng'
  ).replace(/\/$/, '')
  const reviewLink = `${frontendBaseUrl}/patient?rate=${consultationId}`

  if (patientEmail) {
    await sendEmail(
      patientEmail,
      `How was your consultation with Dr. ${doctorName}?`,
      'consultation-ended-feedback',
      {
        patientName,
        doctorName,
        consultationDate: String(consultation?.date || ''),
        consultationTime: String(consultation?.time || ''),
        reviewLink
      },
      'consultation'
    )
  } else {
    logger.warn('Feedback prompt: patient email not available', {
      consultationId,
      patientId
    })
  }

  await sendPatientNotification(patientId, {
    title: 'How was your consultation?',
    body: `How was your consultation with Dr. ${doctorName}? Leave feedback to help improve care.`,
    data: {
      type: 'consultation-feedback',
      consultationId,
      url: `/consultations/${consultationId}?rate=true`
    }
  })
}

/**
 * Listens for consultations transitioning into a finished state and prompts
 * the patient for feedback exactly once (guarded by `feedbackPromptSentAt`).
 */
const startConsultationEndListener = async (): Promise<(() => void)> => {
  const db = getAdminFirestore()

  logger.info('Starting consultations feedback-prompt listener')

  const unsubscribe = db
    .collection('consultations')
    .onSnapshot(
      snapshot => {
        snapshot.docChanges().forEach(change => {
          if (change.type === 'removed') {
            lastSeenStatuses.delete(change.doc.id)
            return
          }

          const consultationId = change.doc.id
          const after = change.doc.data() as any
          const previousStatus = lastSeenStatuses.get(consultationId)
          lastSeenStatuses.set(consultationId, after?.status)

          if (
            after?.patientLeftAReview ||
            after?.feedbackPromptSentAt ||
            !isFinishedStatus(after?.status)
          ) {
            return
          }

          // 'modified' changes are real transitions we observed live.
          // 'added' changes fire for every doc on (re)start, so only prompt
          // for consultations that ended recently.
          const transitioned =
            change.type === 'modified'
              ? previousStatus !== undefined && !isFinishedStatus(previousStatus)
              : endedRecently(after?.endedAt)

          if (!transitioned) return

          logger.info('Consultation finished - sending feedback prompt', {
            consultationId,
            status: after?.status,
            changeType: change.type
          })

          sendFeedbackPrompt(consultationId, after)
            .then(() =>
              updateDBAdmin('consultations', consultationId, {
                feedbackPromptSentAt: new Date().toISOString()
              })
            )
            .catch(error => {
              logger.error('Failed to send consultation feedback prompt', {
                consultationId,
                error: error?.message || error
              })
            })
        })
      },
      error => {
        logger.error('consultations feedback listener error', {
          error: error?.message || error
        })
      }
    )

  return () => {
    logger.info('Detaching consultations feedback listener')
    unsubscribe()
  }
}

/**
 * Listens for new patient reviews and keeps the doctor's aggregate rating
 * (`stars` / `reviewCount`) up to date.
 */
const startReviewAggregationListener = async (): Promise<(() => void)> => {
  const db = getAdminFirestore()

  logger.info('Starting consultations-patient-reviews aggregation listener')

  // Backfill aggregates for reviews that already exist.
  try {
    const existing = await db
      .collection('consultations-patient-reviews')
      .get()
    const doctorIds = new Set<string>()
    existing.forEach(doc => {
      const doctorId = (doc.data() as any)?.doctorId
      if (doctorId) doctorIds.add(doctorId)
    })
    doctorIds.forEach(queueDoctorRatingAggregation)
    logger.info('Backfilled review aggregation queue', {
      doctors: doctorIds.size
    })
  } catch (error: any) {
    logger.error('Failed to backfill review aggregates', {
      error: error?.message || error
    })
  }

  const unsubscribe = db
    .collection('consultations-patient-reviews')
    .onSnapshot(
      snapshot => {
        snapshot.docChanges().forEach(change => {
          if (change.type === 'removed') return
          const doctorId = (change.doc.data() as any)?.doctorId
          queueDoctorRatingAggregation(doctorId)
        })
      },
      error => {
        logger.error('consultations-patient-reviews listener error', {
          error: error?.message || error
        })
      }
    )

  return () => {
    logger.info('Detaching consultations-patient-reviews listener')
    unsubscribe()
  }
}

export const startConsultationFeedbackListener = async (): Promise<
  () => Promise<void>
> => {
  const detachEndListener = await startConsultationEndListener()
  const detachReviewListener = await startReviewAggregationListener()

  return async () => {
    detachEndListener()
    detachReviewListener()
    await Promise.allSettled(
      Array.from(pendingRatingAggregations.values())
    )
  }
}
