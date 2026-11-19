import { getMessaging } from 'firebase-admin/messaging'
import { v4 as uuidv4 } from 'uuid'
import { getAdminFirestore } from './firebase/admin.js'
import logger from './logger.js'

export interface DoctorNotificationPayload {
  title: string
  body: string
  data?: { [key: string]: string }
}

/**
 * Sends an in-app notification to a doctor and, when the doctor has registered
 * FCM tokens, a push notification too. Mirrors the backend NotificationService
 * so the worker can notify doctors without depending on the API service.
 *
 * The notification is always persisted to the `notifications` collection
 * (history record) even if no device tokens are available.
 */
export const sendDoctorNotification = async (
  doctorId: string,
  payload: DoctorNotificationPayload
): Promise<void> => {
  try {
    if (!doctorId) return

    const db = getAdminFirestore()
    const notificationId = uuidv4()

    await db.collection('notifications').doc(notificationId).set({
      id: notificationId,
      userId: doctorId,
      role: 'DOCTOR',
      title: payload.title,
      body: payload.body,
      data: payload.data || {},
      isRead: false,
      createdAt: new Date().toISOString()
    })

    const tokensSnapshot = await db
      .collection('userFCMTokens')
      .where('userId', '==', doctorId)
      .get()

    const tokens = tokensSnapshot.docs.map(doc => doc.id)
    if (tokens.length === 0) {
      logger.info('sendDoctorNotification: doctor has no FCM tokens', { doctorId })
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

    logger.info('sendDoctorNotification: push dispatched', {
      doctorId,
      sent: response.successCount,
      failed: response.failureCount
    })
  } catch (error: any) {
    logger.error('sendDoctorNotification: Failed to notify doctor', {
      doctorId,
      error: error?.message || error
    })
  }
}
