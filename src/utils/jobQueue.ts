import { Job, Queue, Worker } from 'bullmq'
import { getAdminFirestore } from './firebase/admin.js'
import { updateDBAdmin } from './firebase/admin-database.js'
import logger from './logger.js'
import { sendEmail as sendUnseenMessageEmail } from '../controllers/consultation/messageController.js'
import { sendPendingConsultationPaymentReminder } from './scheduler/pendingReminder.js'
import { expirePendingConsultationTransaction } from './scheduler/pendingExpiry.js'
import { sendDailyStats, sendWeeklyStats } from './scheduler/dailyStatsJob.js'
import { getBullMQConnectionOptions } from './redis.js'

export const SCHEDULED_JOBS_QUEUE = 'doxa-scheduled-jobs'

type SupportedJobName =
  | 'unseen-message'
  | 'pending-transaction-check'
  | 'pending-transaction-expiry'
  | 'daily-stats'
  | 'weekly-stats'

const processScheduledJob = async (job: Job) => {
  switch (job.name as SupportedJobName) {
    case 'unseen-message':
      return sendUnseenMessageEmail(job.data)
    case 'pending-transaction-check':
      return sendPendingConsultationPaymentReminder(job.data.transactionId)
    case 'pending-transaction-expiry':
      return expirePendingConsultationTransaction(job.data.transactionId)
    case 'daily-stats':
      return sendDailyStats()
    case 'weekly-stats':
      return sendWeeklyStats()
    default:
      throw new Error(`Unsupported scheduled job: ${job.name}`)
  }
}

const migrateFirestoreJobs = async (queue: Queue) => {
  const snapshot = await getAdminFirestore()
    .collection('scheduled-jobs')
    .where('status', '==', 'scheduled')
    .get()

  for (const document of snapshot.docs) {
    const data = document.data()
    const name = data.type as SupportedJobName
    if (
      ![
        'unseen-message',
        'pending-transaction-check',
        'pending-transaction-expiry'
      ].includes(name)
    ) {
      continue
    }

    const existing = await queue.getJob(document.id)
    if (!existing) {
      const runAt = new Date(data.runAt)
      const runAtMillis = runAt.getTime()
      if (!Number.isFinite(runAtMillis)) {
        logger.warn('Skipping scheduled job with invalid runAt', {
          id: document.id,
          runAt: data.runAt
        })
        continue
      }

      await queue.add(name, data.payload || {}, {
        jobId: document.id,
        delay: Math.max(runAtMillis - Date.now(), 0),
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
        removeOnFail: { age: 7 * 24 * 60 * 60, count: 5000 }
      })
    }

    await updateDBAdmin('scheduled-jobs', document.id, {
      status: 'queued-redis',
      queuedAt: new Date().toISOString()
    })
  }

  logger.info('Migrated Firestore scheduled jobs to Redis', {
    count: snapshot.size
  })
}

export const startRedisJobWorker = async () => {
  const connection = getBullMQConnectionOptions()
  const queue = new Queue(SCHEDULED_JOBS_QUEUE, {
    connection
  })

  await queue.upsertJobScheduler(
    'daily-stats-7pm',
    { pattern: '0 19 * * *', tz: 'Africa/Lagos' },
    {
      name: 'daily-stats',
      data: {},
      opts: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 30,
        removeOnFail: 100
      }
    }
  )
  await queue.upsertJobScheduler(
    'weekly-stats-sunday-7pm',
    { pattern: '0 19 * * 0', tz: 'Africa/Lagos' },
    {
      name: 'weekly-stats',
      data: {},
      opts: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 30,
        removeOnFail: 100
      }
    }
  )
  await migrateFirestoreJobs(queue)

  const worker = new Worker(SCHEDULED_JOBS_QUEUE, processScheduledJob, {
    connection,
    concurrency: Number(process.env.WORKER_CONCURRENCY || 5)
  })

  worker.on('completed', job => {
    logger.info('Redis job completed', { id: job.id, name: job.name })
    if (job.id && !job.id.startsWith('repeat:')) {
      updateDBAdmin('scheduled-jobs', job.id, {
        status: 'executed',
        executedAt: new Date().toISOString()
      }).catch(() => {})
    }
  })

  worker.on('failed', (job, error) => {
    logger.error('Redis job failed', {
      id: job?.id,
      name: job?.name,
      error: error.message
    })
    const maxAttempts = Number(job?.opts.attempts || 1)
    if (
      job?.id
      && !job.id.startsWith('repeat:')
      && job.attemptsMade >= maxAttempts
    ) {
      updateDBAdmin('scheduled-jobs', job.id, {
        status: 'failed',
        failedAt: new Date().toISOString(),
        error: error.message
      }).catch(() => {})
    }
  })

  logger.info('Redis job worker started', {
    concurrency: Number(process.env.WORKER_CONCURRENCY || 5)
  })

  return async () => {
    await Promise.allSettled([
      worker.close(),
      queue.close()
    ])
  }
}
