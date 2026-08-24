const LOCAL_REDIS_URL = 'redis://localhost:6379'

/**
 * Resolve Redis only when a queue/probe is actually used. Mirrors the DB env
 * convention (OPENBOOKS_DB_URL) with OPENBOOKS_REDIS_URL, falling back to the
 * plain REDIS_URL and finally a local development instance. Tests must opt in
 * to Redis explicitly so an accidental queue call fails instead of opening a
 * retrying localhost connection that keeps the test runner alive.
 */
export function getRedisUrl(): string {
  const value = process.env.OPENBOOKS_REDIS_URL || process.env.REDIS_URL
  if (value) return value
  if (process.env.NODE_ENV === 'test') {
    throw new Error('[jobs] Redis is disabled in tests unless OPENBOOKS_REDIS_URL (or REDIS_URL) is set.')
  }
  if (process.env.NODE_ENV !== 'production') return LOCAL_REDIS_URL
  throw new Error('[jobs] OPENBOOKS_REDIS_URL (or REDIS_URL) is required.')
}
