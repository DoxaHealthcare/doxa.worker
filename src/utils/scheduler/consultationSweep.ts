import { getAdminFirestore } from '../firebase/admin.js'
import { sendDoctorNotification } from '../notifications.js'
import { discordBotService } from '../../services/discord-bot/index.js'
import logger from '../logger.js'

/**
 * Stale consultation sweep. This job ONLY nudges and flags - it never
 * changes a consultation's status and never ends one (ending triggers the
 * doctor payout, which must stay a human decision).
 *
 * Flood protection:
 * - Consultations in their current state longer than maxAgeDays are not
 *   nudged/flagged individually; they are counted into a single Discord
 *   digest posted at most once per digestMinIntervalMs (timestamp kept in
 *   the ops/consultation-sweep doc).
 * - At most maxSendsPerRun pushes+Discord posts per run. Anything over the
 *   cap does NOT get its flag claimed, so it carries over to the next run.
 *
 * Dry-run is the default: set CONSULTATION_SWEEP_DRY_RUN=false to actually
 * send pushes, write flags and post to Discord.
 */
export const SWEEP_CONFIG = {
  // Push the doctor when a session sits in one of these states too long
  nudgeAfterMs: 2 * 60 * 60 * 1000,
  // Post to Discord for manual review after this long in any state
  flagAfterMs: 24 * 60 * 60 * 1000,
  // Flag (Discord only, no push) when a booking's scheduled time passed
  // this long ago without being accepted/started
  pastScheduleFlagMs: 2 * 60 * 60 * 1000,
  // Older than this in the current state -> digest only, never individually
  maxAgeDays: 7,
  // Hard cap on pushes + Discord posts per run (digest counts as one)
  maxSendsPerRun: 10,
  // ENDED + payoutStatus 'pending' older than this with no wallet tx -> flag
  payoutPendingMs: 30 * 60 * 1000,
  // Minimum gap between stale-count digest posts
  digestMinIntervalMs: 24 * 60 * 60 * 1000,
  dryRun: process.env.CONSULTATION_SWEEP_DRY_RUN !== 'false'
} as const

// Ops doc holding sweep bookkeeping (lastDigestAt). Clients can never read
// or write it - firestore.rules denies everything by default.
const OPS_COLLECTION = 'ops'
const OPS_DOC = 'consultation-sweep'
// Pseudo-key inside staleFlaggedAt for the stuck-payout flag
const PAYOUT_STUCK_KEY = 'PAYOUT_PENDING'

// Statuses the sweep cares about. Legacy ACCEPTED is normalized to UPCOMING.
const SWEEP_STATUSES = [
  'PENDING',
  'UPCOMING',
  'ACCEPTED',
  'INPROGRESS',
  'COMPLETED'
] as const

const normalizeStatus = (status: unknown): string | null => {
  if (typeof status !== 'string') return null
  switch (status) {
    case 'ACCEPTED':
      return 'UPCOMING'
    case 'SUCCESSFUL':
      return 'ENDED'
    case 'CANCELLED':
      return 'CANCELED'
    default:
      return status
  }
}

const parseTime = (value: unknown): number | null => {
  if (typeof value !== 'string' || !value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/**
 * When the consultation entered its current status, in epoch ms.
 * Prefers the matching statusHistory event, then status-specific fields,
 * then updatedAt/consultatedAt as last resorts. Returns null when nothing
 * usable exists (caller skips the doc).
 */
export const stateSinceMs = (
  consultation: Record<string, any>
): number | null => {
  const status = normalizeStatus(consultation?.status)
  const history = Array.isArray(consultation?.statusHistory)
    ? consultation.statusHistory
    : []

  // Latest history event for the current normalized status
  for (let i = history.length - 1; i >= 0; i--) {
    const event = history[i] as any
    if (normalizeStatus(event?.status) === status) {
      const ms = parseTime(event?.at)
      if (ms !== null) return ms
    }
  }

  if (status === 'INPROGRESS' || status === 'COMPLETED') {
    const ms = parseTime(consultation?.startedAt)
    if (ms !== null) return ms
  }
  if (status === 'ENDED' || status === 'CANCELED') {
    const ms = parseTime(consultation?.endedAt)
    if (ms !== null) return ms
  }

  return (
    parseTime(consultation?.updatedAt) ??
    parseTime(consultation?.consultatedAt) ??
    parseTime(consultation?.createdAt)
  )
}

export interface SweepDeps {
  db?: FirebaseFirestore.Firestore
  sendDoctor?: typeof sendDoctorNotification
  discord?: { sendLogMessage: (msg: string) => Promise<unknown> }
  now?: () => number
  dryRun?: boolean
  config?: Partial<typeof SWEEP_CONFIG>
}

export interface SweepResult {
  scanned: number
  nudged: number
  flagged: number
  digested: number
  stuckPayouts: number
}

const hoursLabel = (ms: number): string =>
  `${(ms / (60 * 60 * 1000)).toFixed(1)}h`

const daysLabel = (ms: number): string =>
  `${(ms / (24 * 60 * 60 * 1000)).toFixed(1)}d`

/**
 * Claims a per-status flag inside a transaction so concurrent workers or a
 * restart mid-send can't double-nudge. Returns true when this caller won.
 */
const claimFlag = async (
  db: FirebaseFirestore.Firestore,
  docRef: FirebaseFirestore.DocumentReference,
  field: 'staleFlaggedAt' | 'staleNudgeSentAt',
  status: string
): Promise<boolean> => {
  const nowIso = new Date().toISOString()
  return db.runTransaction(async tx => {
    const snap = await tx.get(docRef)
    if (!snap.exists) return false
    const data = snap.data() as Record<string, any>
    const flags = { ...((data?.[field] as any) || {}) }
    if (flags[status]) return false
    flags[status] = nowIso
    tx.update(docRef, { [field]: flags })
    return true
  })
}

/**
 * Claims the digest slot: returns true at most once per
 * digestMinIntervalMs. The timestamp lives in ops/consultation-sweep, not
 * on any consultation doc.
 */
const claimDigestSlot = async (
  db: FirebaseFirestore.Firestore,
  minIntervalMs: number,
  now: number
): Promise<boolean> => {
  const ref = db.collection(OPS_COLLECTION).doc(OPS_DOC)
  const nowIso = new Date(now).toISOString()
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref)
    const last = parseTime((snap.data() as any)?.lastDigestAt)
    if (last !== null && now - last < minIntervalMs) return false
    tx.set(ref, { lastDigestAt: nowIso }, { merge: true })
    return true
  })
}

/**
 * ENDED consultations whose payout never finished: status ENDED,
 * payoutStatus 'pending', pending for > payoutPendingMs, and no
 * wallets-transactions doc. Flags once per consultation via the
 * staleFlaggedAt map under the PAYOUT_STUCK_KEY pseudo-status.
 */
const processStuckPayouts = async (
  db: FirebaseFirestore.Firestore,
  discord: { sendLogMessage: (msg: string) => Promise<unknown> },
  now: number,
  dryRun: boolean,
  cfg: typeof SWEEP_CONFIG,
  budget: { used: number }
): Promise<number> => {
  let flagged = 0
  const snapshot = await db
    .collection('consultations')
    .where('status', '==', 'ENDED')
    .where('payoutStatus', '==', 'pending')
    .limit(200)
    .get()

  for (const docSnap of snapshot.docs) {
    const consultation = docSnap.data() as Record<string, any>
    const consultationId = docSnap.id
    const sinceMs = stateSinceMs(consultation)
    if (sinceMs === null) continue
    const pendingMs = now - sinceMs
    if (pendingMs < cfg.payoutPendingMs) continue

    const flags: Record<string, unknown> =
      (consultation?.staleFlaggedAt as any) || {}
    if (flags[PAYOUT_STUCK_KEY]) continue

    const walletSnap = await db
      .collection('wallets-transactions')
      .where('consultationId', '==', consultationId)
      .limit(1)
      .get()
    if (!walletSnap.empty) continue

    const doctorId = consultation?.doctorId as string | undefined
    const message =
      `💸 **[Stuck payout]** \`${consultationId}\`\n` +
      `• **Doctor:** \`${doctorId}\` • **Pending for:** ${hoursLabel(pendingMs)}\n` +
      `• payoutStatus is 'pending' but no wallets-transactions doc exists. ` +
      `The server likely stopped mid-finalize. ` +
      `Use POST /v1/api/consultation/${consultationId}/payout/retry (x-admin-key) ` +
      `to re-run it - it is idempotent.`

    if (dryRun) {
      logger.info('[sweep:dry-run] would flag stuck payout', {
        consultationId,
        pendingFor: hoursLabel(pendingMs)
      })
      continue
    }
    if (budget.used >= cfg.maxSendsPerRun) continue // carry over, no claim

    const claimed = await claimFlag(
      db,
      docSnap.ref,
      'staleFlaggedAt',
      PAYOUT_STUCK_KEY
    )
    if (!claimed) continue

    budget.used++
    flagged++
    await discord.sendLogMessage(message).catch((err: any) =>
      logger.error('consultationSweep: stuck-payout flag failed', {
        consultationId,
        error: err?.message || err
      })
    )
  }
  return flagged
}

/**
 * Runs one sweep pass. Exported with injectable deps so tests can run it
 * against an in-memory store.
 */
export const processConsultationSweep = async (
  deps: SweepDeps = {}
): Promise<SweepResult> => {
  const db = deps.db || getAdminFirestore()
  const sendDoctor = deps.sendDoctor || sendDoctorNotification
  const discord =
    deps.discord ||
    ({ sendLogMessage: (m: string) => discordBotService.sendLogMessage(m) } as any)
  const now = deps.now ? deps.now() : Date.now()
  const dryRun = deps.dryRun ?? SWEEP_CONFIG.dryRun
  const cfg = { ...SWEEP_CONFIG, ...(deps.config || {}) }

  const result: SweepResult = {
    scanned: 0,
    nudged: 0,
    flagged: 0,
    digested: 0,
    stuckPayouts: 0
  }
  const budget = { used: 0 }

  // Stuck payouts first - they are the rarest and most urgent signal.
  result.stuckPayouts = await processStuckPayouts(
    db,
    discord,
    now,
    dryRun,
    cfg,
    budget
  )

  const snapshot = await db
    .collection('consultations')
    .where('active', '==', true)
    .where('status', 'in', [...SWEEP_STATUSES])
    .get()

  // Consultations older than maxAgeDays in their current state are not
  // individually flagged or nudged - they go into one digest instead.
  const oldOnes: { id: string; status: string; sinceMs: number }[] = []

  for (const docSnap of snapshot.docs) {
    result.scanned++
    const consultation = docSnap.data() as Record<string, any>
    const consultationId = docSnap.id
    const status = normalizeStatus(consultation?.status)
    const doctorId = consultation?.doctorId as string | undefined
    const patientId = consultation?.patientId as string | undefined
    if (!status || !doctorId) continue

    const sinceMs = stateSinceMs(consultation)
    if (sinceMs === null) continue
    const inStateMs = now - sinceMs
    if (inStateMs < 0) continue

    if (inStateMs > cfg.maxAgeDays * 24 * 60 * 60 * 1000) {
      oldOnes.push({ id: consultationId, status, sinceMs })
      continue
    }

    const isScheduled = status === 'PENDING' || status === 'UPCOMING'
    const staleFlags: Record<string, unknown> =
      (consultation?.staleFlaggedAt as any) || {}
    const staleNudges: Record<string, unknown> =
      (consultation?.staleNudgeSentAt as any) || {}

    // --- Discord manual-review flag (once per status) ---
    // Scheduled bookings flag on consultatedAt being >2h in the past;
    // in-session states flag after 24h in the same status.
    const scheduledAtMs = parseTime(consultation?.consultatedAt) ?? sinceMs
    const shouldFlag = isScheduled
      ? scheduledAtMs < now - cfg.pastScheduleFlagMs
      : inStateMs > cfg.flagAfterMs

    if (shouldFlag && !staleFlags[status]) {
      if (dryRun) {
        logger.info('[sweep:dry-run] would flag consultation', {
          consultationId,
          status,
          inState: hoursLabel(inStateMs)
        })
      } else if (budget.used >= cfg.maxSendsPerRun) {
        // over cap: skip WITHOUT claiming so it carries to the next run
      } else {
        const claimed = await claimFlag(db, docSnap.ref, 'staleFlaggedAt', status)
        if (claimed) {
          budget.used++
          result.flagged++
          await discord
            .sendLogMessage(
              `⏰ **[Stale consultation]** \`${consultationId}\`\n` +
                `• **Status:** ${status} (for ${hoursLabel(inStateMs)})\n` +
                `• **Doctor:** \`${doctorId}\` • **Patient:** \`${patientId}\`\n` +
                `• Needs manual review - no action taken.`
            )
            .catch((err: any) =>
              logger.error('consultationSweep: Discord flag failed', {
                consultationId,
                error: err?.message || err
              })
            )
        }
      }
    }

    // --- Doctor push nudge (once per status, never during an active call) ---
    const nudgeStatus =
      (status === 'INPROGRESS' || status === 'COMPLETED') &&
      inStateMs > cfg.nudgeAfterMs
    if (!nudgeStatus || staleNudges[status] || consultation?.activeCall) {
      continue
    }

    const copy =
      status === 'INPROGRESS'
        ? {
            title: 'Consultation still in progress',
            body: 'You have a consultation still marked in progress. Remember to complete it.'
          }
        : {
            title: 'Consultation not ended',
            body: 'Your completed consultation hasn\'t been ended yet. Ending it closes the session and starts your payout.'
          }

    if (dryRun) {
      logger.info('[sweep:dry-run] would nudge doctor', {
        consultationId,
        status,
        doctorId
      })
      continue
    }
    if (budget.used >= cfg.maxSendsPerRun) continue // carry over, no claim

    const claimed = await claimFlag(db, docSnap.ref, 'staleNudgeSentAt', status)
    if (!claimed) continue

    budget.used++
    result.nudged++
    await sendDoctor(doctorId, {
      title: copy.title,
      body: copy.body,
      data: {
        type: 'consultation-status',
        consultationId,
        status
      }
    }).catch(err =>
      logger.error('consultationSweep: doctor nudge failed', {
        consultationId,
        doctorId,
        error: err?.message || err
      })
    )
  }

  // --- Digest for consultations stale beyond maxAgeDays ---
  if (oldOnes.length > 0) {
    const byStatus = new Map<string, number>()
    for (const o of oldOnes) {
      byStatus.set(o.status, (byStatus.get(o.status) || 0) + 1)
    }
    const oldest = [...oldOnes]
      .sort((a, b) => a.sinceMs - b.sinceMs)
      .slice(0, 5)
      .map(o => `\`${o.id}\` (${o.status}, ${daysLabel(now - o.sinceMs)} old)`)
      .join('\n')
    const breakdown = [...byStatus.entries()]
      .map(([s, n]) => `${s}: ${n}`)
      .join(', ')
    const message =
      `🧹 **[Stale consultation digest]** ${oldOnes.length} consultation(s) ` +
      `have been in their current state for over ${cfg.maxAgeDays} days ` +
      `(too old for individual nudges).\n` +
      `• **Breakdown:** ${breakdown}\n` +
      `• **Oldest:**\n${oldest}`

    if (dryRun) {
      logger.info('[sweep:dry-run] would post stale digest', {
        count: oldOnes.length,
        breakdown
      })
    } else if (budget.used >= cfg.maxSendsPerRun) {
      // over cap: digest slot is NOT claimed, retries next run
    } else {
      const claimed = await claimDigestSlot(db, cfg.digestMinIntervalMs, now)
      if (claimed) {
        budget.used++
        result.digested = oldOnes.length
        await discord.sendLogMessage(message).catch((err: any) =>
          logger.error('consultationSweep: digest post failed', {
            error: err?.message || err
          })
        )
      }
    }
  }

  return result
}

// Production Firebase project. The sweep refuses to run live (dryRun=false)
// against it unless CONSULTATION_SWEEP_CONFIRM_PROD=true is also set, so a
// dev/staging env file can't accidentally nudge real doctors.
const PROD_PROJECT_ID = 'doxa-1e19d'

export const runConsultationSweep = async (): Promise<void> => {
  try {
    if (
      !SWEEP_CONFIG.dryRun &&
      process.env.FIREBASE_PROJECT_ID === PROD_PROJECT_ID &&
      process.env.CONSULTATION_SWEEP_CONFIRM_PROD !== 'true'
    ) {
      logger.error(
        'consultationSweep: REFUSING to run live against production. ' +
          'Set CONSULTATION_SWEEP_CONFIRM_PROD=true to confirm, or keep ' +
          'CONSULTATION_SWEEP_DRY_RUN=true (default).'
      )
      return
    }
    const result = await processConsultationSweep()
    logger.info('consultationSweep: sweep complete', {
      ...result,
      dryRun: SWEEP_CONFIG.dryRun
    })
  } catch (err: any) {
    logger.error('consultationSweep: sweep failed', {
      error: err?.message || err
    })
  }
}
