import { Request, Response } from 'express'
import { scheduleJob, Job } from 'node-schedule'
import { getDBAdmin } from '../../utils/firebase/admin-database.js'
import { sendEmail as sendTemplateEmail } from '../../services/emailService.js'
import logger from '../../utils/logger.js'
import {
  createDBAdmin,
  updateDBAdmin
} from '../../utils/firebase/admin-database.js'

// Helper to send unseen message notification email
const unSeenEmail = async ({
  sender,
  receiver,
  unseenMessages,
  isPatient
}: {
  sender: any
  receiver: any
  unseenMessages: number
  isPatient: boolean
}) => {
  const subject = `${sender?.fullName || 'A user'} just messaged you`
  const userType = isPatient ? 'patient' : 'doctor'

  logger.info('Preparing unseen-message email', {
    to: receiver?.email,
    userType,
    unseenMessages,
    senderName: sender?.fullName
  })

  await sendTemplateEmail(receiver?.email, subject, 'unseen-message', {
    fullName: sender?.fullName || 'User',
    unseenMessages: String(unseenMessages || 0),
    profileImage: sender?.profileImage || '',
    userType
  })

  logger.info('Unseen-message email sent', {
    to: receiver?.email,
    subject
  })
}

export const sendEmail = async ({
  consultationsChat,
  receiverId,
  senderId
}: {
  consultationsChat: string
  receiverId: string
  senderId: string
}) => {
  try {
    logger.info('sendEmail invoked', {
      consultationsChat,
      receiverId,
      senderId
    })

    const { success, data: BookingChat } = await getDBAdmin(
      'consultations-chats',
      consultationsChat
    )

    if (!success || !BookingChat) {
      logger.warn('BookingChat not found', {
        consultationsChat,
        receiverId,
        senderId
      })
      return { error: 'BookingChat not found', receiverId, senderId }
    }

    logger.debug('BookingChat fetched', {
      consultationsChat,
      hasSeenMap: Boolean(BookingChat?.seen),
      unseenCount: BookingChat?.unseenMessages?.[receiverId] || 0
    })

    const seen = BookingChat.seen?.[receiverId]

    if (seen) {
      logger.info('Chat has no unseen messages', {
        consultationsChat,
        receiverId
      })
      return { error: 'Chat has no unseen messages' }
    }

    const { success: senderSuccess, data: sender } = await getDBAdmin(
      BookingChat.patientId !== senderId ? 'doctors' : 'patients',
      senderId
    )

    const { success: receiverSuccess, data: receiver } = await getDBAdmin(
      BookingChat.patientId !== receiverId ? 'doctors' : 'patients',
      receiverId
    )

    logger.debug('Participants fetched', {
      senderSuccess,
      receiverSuccess,
      senderEmail: sender?.email,
      receiverEmail: receiver?.email
    })

    if (receiverSuccess && senderSuccess && receiver && sender) {
      const unseenMessages = BookingChat.unseenMessages?.[receiverId] || 0
      logger.info('Triggering unseen-message email', {
        consultationsChat,
        receiverId,
        senderId,
        unseenMessages,
        isPatient: BookingChat.patientId !== receiverId
      })

      await unSeenEmail({
        sender,
        unseenMessages,
        receiver,
        isPatient: BookingChat.patientId !== receiverId
      })
      return {
        sender: sender.email,
        unseenMessages,
        receiver: receiver.email,
        isPatient: BookingChat.patientId !== receiverId
      }
    } else {
      logger.warn(
        'Unable to send unseen-message email: participant lookup failed',
        {
          consultationsChat,
          receiverId,
          senderId,
          senderSuccess,
          receiverSuccess
        }
      )
      return { error: false }
    }
  } catch (error: any) {
    logger.error('sendEmail: Server error', {
      error,
      consultationsChat,
      receiverId,
      senderId
    })
    return { error: 'Server error' }
  }
}

const scheduledJobs: Record<string, Job> = {}

export const handleCancelJobs = (id: string, maybeid: string) => {
  logger.info('Cancelling scheduled jobs if present', { id, maybeid })
  if (scheduledJobs[id]) {
    scheduledJobs[id].cancel()
    delete scheduledJobs[id]
    logger.info('Job canceled', { id })
    updateDBAdmin('scheduled-jobs', id, {
      status: 'canceled',
      canceledAt: new Date().toISOString()
    }).catch(() => {})
  }
  if (scheduledJobs[maybeid]) {
    scheduledJobs[maybeid].cancel()
    delete scheduledJobs[maybeid]
    logger.info('Job canceled', { id: maybeid })
    updateDBAdmin('scheduled-jobs', maybeid, {
      status: 'canceled',
      canceledAt: new Date().toISOString()
    }).catch(() => {})
  }
}

export const checkUnSeenMessages = async (req: Request, res: Response) => {
  const { consultationsChat, senderId, receiverId } = req.params as any

  try {
    res.status(200).json({ message: 'Job scheduled successfully' })

    const id = `${senderId}${receiverId}`
    logger.info('Scheduling unseen message check', {
      id,
      consultationsChat,
      senderId,
      receiverId
    })
    const maybeid = `${receiverId}${senderId}`

    handleCancelJobs(id, maybeid)
    const runDate = new Date()
    runDate.setMinutes(runDate.getMinutes() + 1)

    logger.info('Scheduling job at runDate', {
      id,
      runDate: runDate.toISOString()
    })

    const job = scheduleJob(runDate, async (fireDate: Date) => {
      const response = await sendEmail({
        consultationsChat,
        receiverId,
        senderId
      })
      logger.info('Unseen message job executed', {
        fireDate,
        now: new Date(),
        response
      })
      handleCancelJobs(id, maybeid)
      await updateDBAdmin('scheduled-jobs', id, {
        status: 'executed',
        executedAt: new Date().toISOString()
      }).catch(() => {})
    })

    scheduledJobs[id] = job as Job

    await createDBAdmin('scheduled-jobs', id, {
      type: 'unseen-message',
      runAt: runDate.toISOString(),
      status: 'scheduled',
      payload: { consultationsChat, receiverId, senderId },
      createdAt: new Date().toISOString()
    })

    logger.info('Unseen-message job persisted', {
      id,
      runAt: runDate.toISOString(),
      payload: { consultationsChat, receiverId, senderId }
    })
  } catch (error: any) {
    logger.error('Failed to schedule unseen message job', {
      error,
      consultationsChat,
      senderId,
      receiverId
    })
    res.status(500).json({ error })
  }
}
