import logger from '../../utils/logger.js'
import { getAdminFirestore } from '../../utils/firebase/admin.js'
import {
  createDBAdmin,
  updateDBAdmin
} from '../../utils/firebase/admin-database.js'
import {
  isRedisQueueEnabled,
  removeDelayedJob,
  replaceDelayedJob
} from '../../utils/jobQueue.js'

interface ConsultationsChatDoc {
  id?: string
  patientId?: string
  doctorId?: string
  seen?: Record<string, boolean>
  unseenMessages?: Record<string, number>
  unseenEmailSent?: Record<string, boolean>
  sentat?: string
  consultationsChat?: string
  lastMessage?: string
  lastMessageAt?: string
}

type UnseenSnapshot = Record<string, number | undefined>

const previousUnseenSnapshots = new Map<string, UnseenSnapshot>()

const handleCancelJobs = async (id: string, maybeid: string) => {
  if (isRedisQueueEnabled()) {
    await Promise.allSettled([
      removeDelayedJob(id),
      removeDelayedJob(maybeid)
    ])
    await Promise.allSettled([
      updateDBAdmin('scheduled-jobs', id, {
        status: 'canceled',
        canceledAt: new Date().toISOString()
      }),
      updateDBAdmin('scheduled-jobs', maybeid, {
        status: 'canceled',
        canceledAt: new Date().toISOString()
      })
    ])
    return
  }

  logger.info('Requesting job cancellation via database', { id, maybeid })
  await Promise.allSettled([
    updateDBAdmin('scheduled-jobs', id, {
      status: 'canceled',
      canceledAt: new Date().toISOString()
    }),
    updateDBAdmin('scheduled-jobs', maybeid, {
      status: 'canceled',
      canceledAt: new Date().toISOString()
    })
  ])
}

const scheduleUnseenMessageJob = async ({
  consultationsChat,
  senderId,
  receiverId
}: {
  consultationsChat: string
  senderId: string
  receiverId: string
}) => {
  if (!consultationsChat || !senderId || !receiverId) return

  const id = `${senderId}${receiverId}`
  const maybeid = `${receiverId}${senderId}`

  logger.info('Scheduling unseen message check (listener)', {
    id,
    consultationsChat,
    senderId,
    receiverId
  })

  await updateDBAdmin('consultations-chats', consultationsChat, {
    [`unseenEmailSent.${receiverId}`]: false,
    updatedAt: new Date().toISOString()
  }).catch(() => {})

  await handleCancelJobs(id, maybeid)

  const runDate = new Date()
  runDate.setMinutes(runDate.getMinutes() + 1)

  logger.info('Scheduling job at runDate', {
    id,
    runAt: runDate.toISOString()
  })

  if (isRedisQueueEnabled()) {
    await replaceDelayedJob({
      id,
      name: 'unseen-message',
      data: { consultationsChat, receiverId, senderId },
      runAt: runDate
    })
    logger.info('Unseen-message job queued in Redis', {
      id,
      runAt: runDate.toISOString()
    })
    return
  }

  await createDBAdmin('scheduled-jobs', id, {
    type: 'unseen-message',
    runAt: runDate.toISOString(),
    status: 'scheduled',
    payload: { consultationsChat, receiverId, senderId },
    createdAt: new Date().toISOString()
  })

  logger.info('Unseen-message job persisted for worker', {
    id,
    runAt: runDate.toISOString()
  })
}

const determineSenderAndReceiver = (
  docId: string,
  afterData: ConsultationsChatDoc
): { senderId: string; receiverId: string } | null => {
  const patientId = afterData.patientId
  const doctorId = afterData.doctorId

  if (!patientId || !doctorId) {
    return null
  }

  const prevSnapshot = previousUnseenSnapshots.get(docId)
  const afterUnseen = afterData.unseenMessages ?? {}

  const prevUnseenPatient = prevSnapshot?.[patientId] ?? 0
  const prevUnseenDoctor = prevSnapshot?.[doctorId] ?? 0
  const curUnseenPatient = afterUnseen[patientId] ?? 0
  const curUnseenDoctor = afterUnseen[doctorId] ?? 0

  previousUnseenSnapshots.set(docId, { ...afterUnseen })

  if (curUnseenPatient > prevUnseenPatient) {
    return { senderId: doctorId, receiverId: patientId }
  }

  if (curUnseenDoctor > prevUnseenDoctor) {
    return { senderId: patientId, receiverId: doctorId }
  }

  return null
}

export const startUnseenMessageListener = (): (() => Promise<void>) => {
  const db = getAdminFirestore()

  logger.info('Starting consultations-chats Firestore listener')

  const seedPreviousUnseenSnapshots = async () => {
    try {
      const snapshot = await db.collection('consultations-chats').get()
      snapshot.docs.forEach(doc => {
        const data = doc.data() as ConsultationsChatDoc
        if (data.unseenMessages) {
          previousUnseenSnapshots.set(doc.id, { ...data.unseenMessages })
        } else {
          previousUnseenSnapshots.set(doc.id, {})
        }
      })
      logger.info('Seeded previousUnseenSnapshots from Firestore', {
        count: snapshot.size
      })
    } catch (error: any) {
      logger.error('Failed to seed previousUnseenSnapshots on listener start', {
        error: error?.message || error
      })
    }
  }

  seedPreviousUnseenSnapshots().catch(() => {})

  const unsubscribe = db
    .collection('consultations-chats')
    .onSnapshot(
      snapshot => {
        snapshot.docChanges().forEach(change => {
          const consultationsChatId = change.doc.id
          const afterData = change.doc.data() as ConsultationsChatDoc

          if (change.type === 'removed') {
            previousUnseenSnapshots.delete(consultationsChatId)
            logger.debug('Ignoring removed consultations-chats doc', {
              consultationsChatId
            })
            return
          }

          const pair = determineSenderAndReceiver(consultationsChatId, afterData)
          if (!pair) {
            logger.debug('No unseen-message increase detected', {
              consultationsChatId
            })
            return
          }

          logger.info(
            'Unseen-message increment detected in consultations-chats',
            {
              consultationsChatId,
              senderId: pair.senderId,
              receiverId: pair.receiverId
            }
          )

          const consultationsChat =
            afterData.consultationsChat || consultationsChatId

          scheduleUnseenMessageJob({
            consultationsChat,
            senderId: pair.senderId,
            receiverId: pair.receiverId
          }).catch(error => {
            logger.error('Failed to schedule unseen-message job', {
              error: error?.message || error,
              consultationsChatId,
              consultationsChat,
              senderId: pair.senderId,
              receiverId: pair.receiverId
            })
          })
        })
      },
      error => {
        logger.error('consultations-chats listener error', {
          error: error?.message || error
        })
      }
    )

  logger.info('consultations-chats Firestore listener attached')

  return async () => {
    logger.info('Detaching consultations-chats Firestore listener')
    unsubscribe()
    previousUnseenSnapshots.clear()
  }
}
