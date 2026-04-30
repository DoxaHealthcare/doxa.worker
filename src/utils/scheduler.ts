import { scheduleJob, Job } from 'node-schedule'
import { getAdminFirestore } from './firebase/admin.js'
import { updateDBAdmin, createDBAdmin } from './firebase/admin-database.js'
import logger from './logger.js'
import { sendEmail as sendUnseenMessageEmail } from '../controllers/consultation/messageController.js'
import { sendPendingConsultationPaymentReminder } from './scheduler/pendingReminder.js'
import { expirePendingConsultationTransaction } from './scheduler/pendingExpiry.js'
import { sendDailyStats, sendWeeklyStats } from './scheduler/dailyStatsJob.js'

const restoredJobs: Record<string, Job> = {}

export const scheduleDailyStatsJob = (): void => {
  // Schedule daily stats to run every day at 7 PM (19:00)
  scheduleJob('0 19 * * *', async () => {
    logger.info('Running scheduled daily stats job at 7 PM')
    await sendDailyStats()
  })
  
  // Schedule weekly stats to run every Sunday at 7 PM (19:00)
  scheduleJob('0 19 * * 0', async () => {
    logger.info('Running scheduled weekly stats job at 7 PM (Sunday)')
    await sendWeeklyStats()
  })

  logger.info('Daily and Weekly stats jobs scheduled')
}

export const restoreUnSeenMessageJobs = async (): Promise<void> => {
  try {
    const db = getAdminFirestore()
    const snapshot = await db
      .collection('scheduled-jobs')
      .where('type', '==', 'unseen-message')
      .where('status', '==', 'scheduled')
      .get()

    const now = new Date()

    snapshot.forEach(doc => {
      const data = doc.data() as any
      const runAt = new Date(data.runAt)
      const scheduleDate = runAt > now ? runAt : new Date(now.getTime() + 10000)
      const id = doc.id

      if (restoredJobs[id]) {
        restoredJobs[id].cancel()
        delete restoredJobs[id]
      }

      const job = scheduleJob(scheduleDate, async (fireDate: Date) => {
        const payload = data.payload || {}
        const response = await sendUnseenMessageEmail(payload)
        logger.info('Restored unseen message job executed', {
          id,
          fireDate,
          response
        })
        await updateDBAdmin('scheduled-jobs', id, {
          status: 'executed',
          executedAt: new Date().toISOString()
        }).catch(() => {})
        // remove local restored job reference
        if (restoredJobs[id]) {
          restoredJobs[id].cancel()
          delete restoredJobs[id]
        }
      })

      restoredJobs[id] = job as Job
      logger.info('Restored unseen message job scheduled', { id, scheduleDate })
    })

    logger.info('Restore routine completed for unseen-message jobs', {
      count: snapshot.size
    })
  } catch (error: any) {
    logger.error('Failed to restore unseen-message jobs', { error })
  }
}

// Schedule a 10-minute check for a pending consultation transaction
export const schedulePendingTransactionCheck = async (
  transactionId: string
): Promise<void> => {
  try {
    if (!transactionId || typeof transactionId !== 'string') {
      logger.warn('schedulePendingTransactionCheck: Invalid transactionId', {
        transactionId
      })
      return
    }

    const id = `pending-tx-${transactionId}`
    const runDate = new Date(Date.now() + 10 * 60 * 1000)

    // Cancel any existing local job ref
    if (restoredJobs[id]) {
      restoredJobs[id].cancel()
      delete restoredJobs[id]
    }

    const job = scheduleJob(runDate, async (fireDate: Date) => {
      try {
        await sendPendingConsultationPaymentReminder(transactionId)

        await updateDBAdmin('scheduled-jobs', id, {
          status: 'executed',
          executedAt: new Date().toISOString()
        }).catch(() => {})
      } finally {
        if (restoredJobs[id]) {
          restoredJobs[id].cancel()
          delete restoredJobs[id]
        }
      }
    })

    restoredJobs[id] = job as Job

    await createDBAdmin('scheduled-jobs', id, {
      type: 'pending-transaction-check',
      runAt: runDate.toISOString(),
      status: 'scheduled',
      payload: { transactionId },
      createdAt: new Date().toISOString()
    })

    logger.info('Pending transaction job scheduled and persisted', {
      id,
      runAt: runDate.toISOString(),
      transactionId
    })
  } catch (error: any) {
    logger.error('schedulePendingTransactionCheck: Failed to schedule job', {
      error
    })
  }
}

export const restorePendingTransactionJobs = async (): Promise<void> => {
  try {
    const db = getAdminFirestore()
    const snapshot = await db
      .collection('scheduled-jobs')
      .where('type', '==', 'pending-transaction-check')
      .where('status', '==', 'scheduled')
      .get()

    const now = new Date()

    snapshot.forEach(doc => {
      const data = doc.data() as any
      const runAt = new Date(data.runAt)
      const scheduleDate = runAt > now ? runAt : new Date(now.getTime() + 10000)
      const id = doc.id

      if (restoredJobs[id]) {
        restoredJobs[id].cancel()
        delete restoredJobs[id]
      }

      const job = scheduleJob(scheduleDate, async (fireDate: Date) => {
        try {
          const payload = data.payload || {}
          const transactionId = payload?.transactionId as string
          await sendPendingConsultationPaymentReminder(transactionId)

          logger.info('Restored pending transaction job executed', {
            id,
            fireDate
          })

          await updateDBAdmin('scheduled-jobs', id, {
            status: 'executed',
            executedAt: new Date().toISOString()
          }).catch(() => {})
        } finally {
          if (restoredJobs[id]) {
            restoredJobs[id].cancel()
            delete restoredJobs[id]
          }
        }
      })

      restoredJobs[id] = job as Job
      logger.info('Restored pending transaction job scheduled', { id, scheduleDate })
    })

    logger.info('Restore routine completed for pending-transaction-check jobs', {
      count: snapshot.size
    })
  } catch (error: any) {
    logger.error('Failed to restore pending-transaction-check jobs', { error })
  }
}

// Schedule a job to expire a pending consultation transaction at virtual account's expiry time
export const schedulePendingTransactionExpiryCheck = async (
  transactionId: string
): Promise<void> => {
  try {
    if (!transactionId || typeof transactionId !== 'string') {
      logger.warn('schedulePendingTransactionExpiryCheck: Invalid transactionId', {
        transactionId
      })
      return
    }

    const db = getAdminFirestore()
    const txDoc = await db
      .collection('consultation-transactions')
      .doc(transactionId)
      .get()

    if (!txDoc.exists) {
      logger.warn('schedulePendingTransactionExpiryCheck: transaction not found', {
        transactionId
      })
      return
    }

    const txData = txDoc.data() as any
    const expiredAtStr = txData?.virtualAccountData?.expiredAt || txData?.virtualAccountData?.expiryTime || ''
    const expiredAt = expiredAtStr ? new Date(expiredAtStr) : null
    const now = new Date()
    const runDate = expiredAt && !isNaN(expiredAt.getTime()) ? expiredAt : new Date(now.getTime() + 10000)

    const id = `pending-tx-expiry-${transactionId}`

    // Cancel any existing local job ref
    if (restoredJobs[id]) {
      restoredJobs[id].cancel()
      delete restoredJobs[id]
    }

    const job = scheduleJob(runDate, async (fireDate: Date) => {
      try {
        await expirePendingConsultationTransaction(transactionId)

        await updateDBAdmin('scheduled-jobs', id, {
          status: 'executed',
          executedAt: new Date().toISOString()
        }).catch(() => {})
      } finally {
        if (restoredJobs[id]) {
          restoredJobs[id].cancel()
          delete restoredJobs[id]
        }
      }
    })

    restoredJobs[id] = job as Job

    await createDBAdmin('scheduled-jobs', id, {
      type: 'pending-transaction-expiry',
      runAt: runDate.toISOString(),
      status: 'scheduled',
      payload: { transactionId },
      createdAt: new Date().toISOString()
    })

    logger.info('Pending transaction expiry job scheduled and persisted', {
      id,
      runAt: runDate.toISOString(),
      transactionId
    })
  } catch (error: any) {
    logger.error('schedulePendingTransactionExpiryCheck: Failed to schedule job', {
      error
    })
  }
}

export const restorePendingTransactionExpiryJobs = async (): Promise<void> => {
  try {
    const db = getAdminFirestore()
    const snapshot = await db
      .collection('scheduled-jobs')
      .where('type', '==', 'pending-transaction-expiry')
      .where('status', '==', 'scheduled')
      .get()

    const now = new Date()

    snapshot.forEach(doc => {
      const data = doc.data() as any
      const runAt = new Date(data.runAt)
      const scheduleDate = runAt > now ? runAt : new Date(now.getTime() + 10000)
      const id = doc.id

      if (restoredJobs[id]) {
        restoredJobs[id].cancel()
        delete restoredJobs[id]
      }

      const job = scheduleJob(scheduleDate, async (fireDate: Date) => {
        try {
          const payload = data.payload || {}
          const transactionId = payload?.transactionId as string
          await expirePendingConsultationTransaction(transactionId)

          logger.info('Restored pending transaction expiry job executed', {
            id,
            fireDate
          })

          await updateDBAdmin('scheduled-jobs', id, {
            status: 'executed',
            executedAt: new Date().toISOString()
          }).catch(() => {})
        } finally {
          if (restoredJobs[id]) {
            restoredJobs[id].cancel()
            delete restoredJobs[id]
          }
        }
      })

      restoredJobs[id] = job as Job
      logger.info('Restored pending transaction expiry job scheduled', { id, scheduleDate })
    })

    logger.info('Restore routine completed for pending-transaction-expiry jobs', {
      count: snapshot.size
    })
  } catch (error: any) {
    logger.error('Failed to restore pending-transaction-expiry jobs', { error })
  }
}