import { getAdminFirestore } from '../firebase/admin.js'
import { discordBotService } from '../../services/discord-bot/index.js'
import logger from '../logger.js'

export const sendDailyStats = async (): Promise<void> => {
  try {
    const db = getAdminFirestore()
    const now = new Date()
    const startOfToday = new Date(now)
    startOfToday.setHours(0, 0, 0, 0)

    const startOfTodayISO = startOfToday.toISOString()

    // Query patients
    const patientsRef = db.collection('patients')
    const totalPatientsSnapshot = await patientsRef.count().get()
    const totalPatients = totalPatientsSnapshot.data().count

    const todayPatientsSnapshot = await patientsRef
      .where('createdAt', '>=', startOfTodayISO)
      .count()
      .get()
    const todayPatients = todayPatientsSnapshot.data().count

    // Query doctors
    const doctorsRef = db.collection('doctors')
    const totalDoctorsSnapshot = await doctorsRef.count().get()
    const totalDoctors = totalDoctorsSnapshot.data().count

    const todayDoctorsSnapshot = await doctorsRef
      .where('createdAt', '>=', startOfTodayISO)
      .count()
      .get()
    const todayDoctors = todayDoctorsSnapshot.data().count

    const message = `
**📊 Daily Stats Report (at 7 PM)**
---
**Patients:**
- Today: ${todayPatients}
- So far: ${totalPatients}

**Doctors:**
- Today: ${todayDoctors}
- So far: ${totalDoctors}
---
    `.trim()

    await discordBotService.sendLogMessage(message)
    logger.info('Daily stats report sent to Discord')
  } catch (error: any) {
    logger.error('Failed to send daily stats report', { error })
  }
}

export const sendWeeklyStats = async (): Promise<void> => {
  try {
    const db = getAdminFirestore()
    const now = new Date()
    
    // Start of last 7 days
    const sevenDaysAgo = new Date(now)
    sevenDaysAgo.setDate(now.getDate() - 7)
    sevenDaysAgo.setHours(0, 0, 0, 0)
    const sevenDaysAgoISO = sevenDaysAgo.toISOString()

    // Query patients
    const patientsRef = db.collection('patients')
    const totalPatientsSnapshot = await patientsRef.count().get()
    const totalPatients = totalPatientsSnapshot.data().count

    const weeklyPatientsSnapshot = await patientsRef
      .where('createdAt', '>=', sevenDaysAgoISO)
      .count()
      .get()
    const weeklyPatients = weeklyPatientsSnapshot.data().count

    // Query doctors
    const doctorsRef = db.collection('doctors')
    const totalDoctorsSnapshot = await doctorsRef.count().get()
    const totalDoctors = totalDoctorsSnapshot.data().count

    const weeklyDoctorsSnapshot = await doctorsRef
      .where('createdAt', '>=', sevenDaysAgoISO)
      .count()
      .get()
    const weeklyDoctors = weeklyDoctorsSnapshot.data().count

    const message = `
**📅 Weekly Stats Report (Last 7 Days)**
---
**Patients:**
- This Week: ${weeklyPatients}
- Total so far: ${totalPatients}

**Doctors:**
- This Week: ${weeklyDoctors}
- Total so far: ${totalDoctors}
---
    `.trim()

    await discordBotService.sendLogMessage(message)
    logger.info('Weekly stats report sent to Discord')
  } catch (error: any) {
    logger.error('Failed to send weekly stats report', { error })
  }
}
