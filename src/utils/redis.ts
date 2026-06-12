import { Redis } from 'ioredis'
import type { ConnectionOptions } from 'bullmq'

export const getRedisUrl = (): string | null => {
  const value = process.env.REDIS_URL?.trim()
  return value || null
}

export const createRedisConnection = (name: string): Redis => {
  const redisUrl = getRedisUrl()
  if (!redisUrl) {
    throw new Error(`REDIS_URL is required for ${name}`)
  }

  const connection = new Redis(redisUrl, {
    connectionName: name,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: true
  })

  connection.on('error', (error: Error) => {
    console.error(`[redis:${name}]`, error)
  })

  return connection
}

export const getBullMQConnectionOptions = (): ConnectionOptions => {
  const redisUrl = getRedisUrl()
  if (!redisUrl) throw new Error('REDIS_URL is required for BullMQ')

  const parsed = new URL(redisUrl)
  const database = parsed.pathname.replace('/', '')

  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    db: database ? Number(database) : 0,
    tls: parsed.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null
  }
}
