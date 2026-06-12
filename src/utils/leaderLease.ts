import { randomUUID } from 'node:crypto'
import { createRedisConnection } from './redis.js'

const RELEASE_LOCK = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
  end
  return 0
`

const RENEW_LOCK = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("PEXPIRE", KEYS[1], ARGV[2])
  end
  return 0
`

export const acquireLeaderLease = async (
  key: string,
  ttlMs = 30000
): Promise<(() => Promise<void>) | null> => {
  const connection = createRedisConnection(`leader-${key}`)
  await connection.connect()

  const token = randomUUID()
  const acquired = await connection.set(key, token, 'PX', ttlMs, 'NX')
  if (acquired !== 'OK') {
    await connection.quit()
    return null
  }

  const renewal = setInterval(async () => {
    try {
      const renewed = await connection.eval(
        RENEW_LOCK,
        1,
        key,
        token,
        String(ttlMs)
      )
      if (Number(renewed) !== 1) clearInterval(renewal)
    } catch {
      clearInterval(renewal)
    }
  }, Math.floor(ttlMs / 3))
  renewal.unref()

  return async () => {
    clearInterval(renewal)
    await connection.eval(RELEASE_LOCK, 1, key, token).catch(() => {})
    await connection.quit().catch(() => {})
  }
}
