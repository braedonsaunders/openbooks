const LOCAL_REDIS_URL = 'redis://localhost:6379'

/**
 * Resolve Redis only when a queue/probe is actually used. Mirrors the DB env
 * convention (OPENBOOKS_DB_URL) with OPENBOOKS_REDIS_URL, falling back to the
 * plain REDIS_URL and finally a local dev instance.
 */
export function getRedisUrl(): string {
  const value = process.env.OPENBOOKS_REDIS_URL || process.env.REDIS_URL
  if (value) return value
  if (process.env.NODE_ENV !== 'production') return LOCAL_REDIS_URL
  throw new Error('[jobs] OPENBOOKS_REDIS_URL (or REDIS_URL) is required.')
}
