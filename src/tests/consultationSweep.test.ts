import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * Tests for the stale-consultation sweep (consultationSweep.ts).
 * Runs against an in-memory Firestore fake via the injectable deps -
 * no emulator needed.
 */

const HOUR = 60 * 60 * 1000
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()

// --- minimal in-memory Firestore fake -------------------------------------

const createFakeDb = (seed: Record<string, any>) => {
  const store = new Map<string, any>(Object.entries(seed))

  const applyFilters = (docs: [string, any][], filters: any[]) =>
    docs.filter(([, data]) =>
      filters.every(({ field, op, value }) => {
        const actual = data?.[field]
        if (op === '==') return actual === value
        if (op === 'in') return (value as any[]).includes(actual)
        return false
      })
    )

  const makeQuery = (name: string, filters: any[] = [], limitN?: number) => ({
    where: (field: string, op: string, value: any) =>
      makeQuery(name, [...filters, { field, op, value }], limitN),
    limit: (n: number) => makeQuery(name, filters, n),
    get: async () => {
      let docs = applyFilters(
        [...store.entries()]
          .filter(([k]) => k.startsWith(`${name}/`))
          .map(([k, v]) => [k.slice(name.length + 1), v]),
        filters
      )
      if (limitN !== undefined) docs = docs.slice(0, limitN)
      return {
        empty: docs.length === 0,
        docs: docs.map(([id, data]) => ({
          id,
          data: () => data,
          ref: makeDocRef(name, id)
        }))
      }
    }
  })

  const makeDocRef = (name: string, id: string): any => ({
    id,
    _path: `${name}/${id}`,
    get: async () => {
      const data = store.get(`${name}/${id}`)
      return { exists: data !== undefined, data: () => data }
    },
    set: async (data: any, opts?: any) => {
      store.set(
        `${name}/${id}`,
        opts?.merge ? { ...store.get(`${name}/${id}`), ...data } : data
      )
    },
    update: async (data: any) => {
      store.set(`${name}/${id}`, { ...store.get(`${name}/${id}`), ...data })
    }
  })

  const db = {
    collection: (name: string) => ({
      ...makeQuery(name),
      doc: (id: string) => makeDocRef(name, id)
    }),
    runTransaction: async (fn: any) =>
      fn({
        get: async (ref: any) => {
          const data = store.get(ref._path || `consultations/${ref.id}`)
          return { exists: data !== undefined, data: () => data }
        },
        update: (ref: any, data: any) => {
          const path = ref._path || `consultations/${ref.id}`
          store.set(path, { ...store.get(path), ...data })
        },
        set: (ref: any, data: any, opts?: any) => {
          const path = ref._path || `consultations/${ref.id}`
          store.set(path, opts?.merge ? { ...store.get(path), ...data } : data)
        }
      })
  }
  return { db: db as any, store }
}

// --- fixtures ---------------------------------------------------------------

const DOCTOR = 'doctor-1'
const PATIENT = 'patient-1'

const baseConsultation = (overrides: Record<string, any> = {}) => ({
  patientId: PATIENT,
  doctorId: DOCTOR,
  status: 'INPROGRESS',
  active: true,
  consultatedAt: iso(3 * HOUR),
  startedAt: iso(3 * HOUR),
  statusHistory: [
    { status: 'INPROGRESS', at: iso(3 * HOUR), by: DOCTOR, via: 'api' }
  ],
  ...overrides
})

const makeDeps = (seed: Record<string, any>) => {
  const { db, store } = createFakeDb(seed)
  const pushes: any[] = []
  const discord: string[] = []
  return {
    store,
    pushes,
    discord,
    deps: {
      db,
      sendDoctor: async (_id: string, payload: any) => {
        pushes.push(payload)
      },
      discord: {
        sendLogMessage: async (m: string) => {
          discord.push(m)
        }
      },
      dryRun: false
    }
  }
}

const { processConsultationSweep } = await import(
  '../utils/scheduler/consultationSweep.js'
)

// --- tests -------------------------------------------------------------------

test('stale INPROGRESS gets one nudge, not a second on re-run', async () => {
  const { deps, pushes, store } = makeDeps({
    'consultations/c1': baseConsultation()
  })
  const first = await processConsultationSweep(deps)
  assert.equal(first.nudged, 1)
  assert.equal(pushes.length, 1)
  assert.match(pushes[0].body, /still marked in progress/)

  const second = await processConsultationSweep(deps)
  assert.equal(second.nudged, 0)
  assert.equal(pushes.length, 1)
  assert.ok(store.get('consultations/c1').staleNudgeSentAt.INPROGRESS)
})

test('INPROGRESS with an active call is not nudged', async () => {
  const { deps, pushes } = makeDeps({
    'consultations/c1': baseConsultation({ activeCall: { room: 'r1' } })
  })
  const res = await processConsultationSweep(deps)
  assert.equal(res.nudged, 0)
  assert.equal(pushes.length, 0)
})

test('stale COMPLETED nudges with the payout message', async () => {
  const { deps, pushes } = makeDeps({
    'consultations/c1': baseConsultation({
      status: 'COMPLETED',
      statusHistory: [
        { status: 'COMPLETED', at: iso(3 * HOUR), by: DOCTOR, via: 'api' }
      ]
    })
  })
  const res = await processConsultationSweep(deps)
  assert.equal(res.nudged, 1)
  assert.match(pushes[0].body, /hasn't been ended yet/)
})

test('INPROGRESS over 24h posts one Discord flag', async () => {
  const { deps, discord, pushes } = makeDeps({
    'consultations/c1': baseConsultation({
      startedAt: iso(25 * HOUR),
      statusHistory: [
        { status: 'INPROGRESS', at: iso(25 * HOUR), by: DOCTOR, via: 'api' }
      ]
    })
  })
  const res = await processConsultationSweep(deps)
  assert.equal(res.flagged, 1)
  assert.equal(discord.length, 1)
  assert.match(discord[0], /c1/)
  // also nudged once (>2h) - flag and nudge are independent
  assert.equal(pushes.length, 1)

  const again = await processConsultationSweep(deps)
  assert.equal(again.flagged, 0)
  assert.equal(discord.length, 1)
})

test('PENDING consultation past its scheduled time flags Discord only', async () => {
  const { deps, discord, pushes } = makeDeps({
    'consultations/c1': {
      patientId: PATIENT,
      doctorId: DOCTOR,
      status: 'PENDING',
      active: true,
      consultatedAt: iso(3 * HOUR)
    }
  })
  const res = await processConsultationSweep(deps)
  assert.equal(res.flagged, 1)
  assert.equal(discord.length, 1)
  assert.equal(pushes.length, 0) // no push for scheduled states
})

test('UPCOMING past consultatedAt also flags', async () => {
  const { deps, discord } = makeDeps({
    'consultations/c1': {
      patientId: PATIENT,
      doctorId: DOCTOR,
      status: 'UPCOMING',
      active: true,
      consultatedAt: iso(3 * HOUR)
    }
  })
  const res = await processConsultationSweep(deps)
  assert.equal(res.flagged, 1)
  assert.equal(discord.length, 1)
})

test('moving INPROGRESS -> COMPLETED earns a fresh nudge for the new state', async () => {
  const { deps, pushes, store } = makeDeps({
    'consultations/c1': baseConsultation()
  })
  await processConsultationSweep(deps)
  assert.equal(pushes.length, 1)

  // Doctor completes the consultation; statusHistory gains a COMPLETED event
  store.set('consultations/c1', {
    ...store.get('consultations/c1'),
    status: 'COMPLETED',
    statusHistory: [
      ...store.get('consultations/c1').statusHistory,
      { status: 'COMPLETED', at: iso(3 * HOUR), by: DOCTOR, via: 'api' }
    ]
  })
  // stateSinceMs for COMPLETED falls back to startedAt (3h ago) -> stale
  const res = await processConsultationSweep(deps)
  assert.equal(res.nudged, 1)
  assert.equal(pushes.length, 2)
  assert.match(pushes[1].body, /hasn't been ended yet/)
})

test('recent consultation is ignored', async () => {
  const { deps, pushes, discord } = makeDeps({
    'consultations/c1': baseConsultation({
      startedAt: iso(30 * 60 * 1000),
      consultatedAt: iso(30 * 60 * 1000),
      statusHistory: [
        { status: 'INPROGRESS', at: iso(30 * 60 * 1000), by: DOCTOR, via: 'api' }
      ]
    })
  })
  const res = await processConsultationSweep(deps)
  assert.equal(res.nudged, 0)
  assert.equal(res.flagged, 0)
  assert.equal(pushes.length, 0)
  assert.equal(discord.length, 0)
})

test('dry-run writes flags nowhere and sends nothing', async () => {
  const { deps, pushes, discord, store } = makeDeps({
    'consultations/c1': baseConsultation()
  })
  deps.dryRun = true
  const res = await processConsultationSweep(deps)
  assert.equal(res.nudged, 0)
  assert.equal(res.flagged, 0)
  assert.equal(pushes.length, 0)
  assert.equal(discord.length, 0)
  assert.equal(store.get('consultations/c1').staleNudgeSentAt, undefined)
})

// --- flood protection --------------------------------------------------------

const DAY = 24 * HOUR

const staleConsultation = (id: string, status: string, daysAgo: number) => ({
  [`consultations/${id}`]: {
    patientId: PATIENT,
    doctorId: DOCTOR,
    status,
    active: true,
    consultatedAt: iso(daysAgo * DAY),
    startedAt: status === 'INPROGRESS' || status === 'COMPLETED' ? iso(daysAgo * DAY) : undefined,
    statusHistory: [
      { status, at: iso(daysAgo * DAY), by: DOCTOR, via: 'api' }
    ]
  }
})

test('consultations older than maxAgeDays produce only a digest', async () => {
  const seed = {
    ...staleConsultation('old1', 'INPROGRESS', 30),
    ...staleConsultation('old2', 'PENDING', 20),
    ...staleConsultation('old3', 'COMPLETED', 10)
  }
  const { deps, pushes, discord, store } = makeDeps(seed)
  const res = await processConsultationSweep(deps)
  assert.equal(res.nudged, 0)
  assert.equal(res.flagged, 0)
  assert.equal(res.digested, 3)
  assert.equal(pushes.length, 0)
  assert.equal(discord.length, 1)
  assert.match(discord[0], /old1/)
  assert.match(discord[0], /INPROGRESS: 1/)
  // no per-consultation flags claimed
  assert.equal(store.get('consultations/old1').staleNudgeSentAt, undefined)
  assert.equal(store.get('consultations/old1').staleFlaggedAt, undefined)
})

test('digest does not repeat inside 24h', async () => {
  const { deps, discord } = makeDeps(staleConsultation('old1', 'INPROGRESS', 30))
  await processConsultationSweep(deps)
  assert.equal(discord.length, 1)
  const res = await processConsultationSweep(deps)
  assert.equal(res.digested, 0)
  assert.equal(discord.length, 1)
})

test('per-run cap carries unclaimed work to the next run', async () => {
  const seed: Record<string, any> = {}
  // 12 stale INPROGRESS docs, each eligible for a nudge (>2h, <7d)
  for (let i = 0; i < 12; i++) {
    seed[`consultations/c${i}`] = baseConsultation()
  }
  const { deps, pushes, store } = makeDeps(seed)
  ;(deps as any).config = { maxSendsPerRun: 5 }
  const first = await processConsultationSweep(deps)
  assert.equal(first.nudged, 5)
  assert.equal(pushes.length, 5)
  // over-cap docs kept no flag -> next run sends the rest
  const second = await processConsultationSweep(deps)
  assert.equal(second.nudged, 5)
  assert.equal(pushes.length, 10)
  const third = await processConsultationSweep(deps)
  assert.equal(third.nudged, 2)
  assert.equal(pushes.length, 12)
  // every doc eventually flagged exactly once
  for (let i = 0; i < 12; i++) {
    assert.ok(store.get(`consultations/c${i}`).staleNudgeSentAt?.INPROGRESS)
  }
})

// --- stuck payouts ------------------------------------------------------------

const endedPendingPayout = (id: string, endedHoursAgo: number) => ({
  [`consultations/${id}`]: {
    patientId: PATIENT,
    doctorId: DOCTOR,
    status: 'ENDED',
    active: false,
    endedAt: iso(endedHoursAgo * HOUR),
    statusHistory: [
      { status: 'ENDED', at: iso(endedHoursAgo * HOUR), by: DOCTOR, via: 'api' }
    ],
    payoutStatus: 'pending'
  }
})

test('stuck payout (ENDED, pending, no wallet tx) flags Discord once', async () => {
  const { deps, discord } = makeDeps(endedPendingPayout('c1', 2))
  const res = await processConsultationSweep(deps)
  assert.equal(res.stuckPayouts, 1)
  assert.equal(discord.length, 1)
  assert.match(discord[0], /Stuck payout/)
  assert.match(discord[0], /payout\/retry/)

  const again = await processConsultationSweep(deps)
  assert.equal(again.stuckPayouts, 0)
  assert.equal(discord.length, 1)
})

test('stuck payout skipped when wallet transaction exists', async () => {
  const { deps, discord } = makeDeps({
    ...endedPendingPayout('c1', 2),
    'wallets-transactions/wt1': { consultationId: 'c1', doctorId: DOCTOR }
  })
  const res = await processConsultationSweep(deps)
  assert.equal(res.stuckPayouts, 0)
  assert.equal(discord.length, 0)
})

test('recently ended pending payout is ignored (<30min)', async () => {
  const { deps, discord } = makeDeps(endedPendingPayout('c1', 0.2)) // 12 min
  const res = await processConsultationSweep(deps)
  assert.equal(res.stuckPayouts, 0)
  assert.equal(discord.length, 0)
})
