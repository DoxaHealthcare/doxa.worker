import { getMessaging } from 'firebase-admin/messaging'
import { v4 as uuidv4 } from 'uuid'
import { getAdminFirestore } from './firebase/admin.js'
import logger from './logger.js'

export interface DoctorNotificationPayload {
  title: string
  body: string
  data?: { [key: string]: string }
}

export type NotificationRole = 'PATIENT' | 'DOCTOR'

/**
 * Sends an in-app notification to a user and, when the user has registered
 * FCM tokens, a push notification too.
 *
 * The notification is always persisted to the `notifications` collection
 * (history record) even if no device tokens are available.
 */
export const sendUserNotification = async (
  userId: string,
  payload: DoctorNotificationPayload,
  role: NotificationRole = 'PATIENT'
): Promise<void> => {
  try {
    if (!userId) return

    const db = getAdminFirestore()
    const notificationId = uuidv4()
    const collectionName = role === 'PATIENT' ? 'patients' : 'doctors'

    const userExists = await db
      .collection(collectionName)
      .doc(userId)
      .get()
      .then(doc => doc.exists)

    if (!userExists) {
      logger.warn('sendUserNotification: user not found', { userId, role })
      return
    }

    await db.collection('notifications').doc(notificationId).set({
      id: notificationId,
      userId,
      role,
      title: payload.title,
      body: payload.body,
      data: payload.data || {},
      isRead: false,
      createdAt: new Date().toISOString()
    })

    const tokensSnapshot = await db
      .collection('userFCMTokens')
      .where('userId', '==', userId)
      .get()

    const tokens = tokensSnapshot.docs.map(doc => doc.id)
    if (tokens.length === 0) {
      logger.info('sendUserNotification: user has no FCM tokens', { userId, role })
      return
    }

    const response = await getMessaging().sendEach(
      tokens.map(token => ({
        token,
        notification: { title: payload.title, body: payload.body },
        data: payload.data
      }))
    )

    const tokensToRemove: string[] = []
    response.responses.forEach((resp, idx) => {
      if (!resp.success) {
        const error = resp.error as any
        if (
          error?.code === 'messaging/registration-token-not-registered' ||
          error?.code === 'messaging/invalid-registration-token'
        ) {
          tokensToRemove.push(tokens[idx])
        }
      }
    })

    if (tokensToRemove.length > 0) {
      const batch = db.batch()
      tokensToRemove.forEach(token => {
        batch.delete(db.collection('userFCMTokens').doc(token))
      })
      await batch.commit()
    }

    logger.info('sendUserNotification: push dispatched', {
      userId,
      role,
      sent: response.successCount,
      failed: response.failureCount
    })
  } catch (error: any) {
    logger.error('sendUserNotification: Failed to send notification', {
      userId,
      role,
      error: error?.message || error
    })
  }
}

export const sendDoctorNotification = (
  doctorId: string,
  payload: DoctorNotificationPayload
): Promise<void> => sendUserNotification(doctorId, payload, 'DOCTOR')

export const sendPatientNotification = (
  patientId: string,
  payload: DoctorNotificationPayload
): Promise<void> => sendUserNotification(patientId, payload, 'PATIENT')
