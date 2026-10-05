import { randomUUID } from 'node:crypto'
import { getReadCacheConnection } from './connection'

/** Cache infrastructure must never hold an ERP request open during an outage. */
async function bounded<T>(operation: () => Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation(),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 250); timer.unref() }),
    ])
  } catch {
    return undefined
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Undefined means unavailable; null means an available cache has no value. */
export const readSharedCache = (key: string) => bounded(async () => (await getReadCacheConnection())?.get(key))
/** Collapse bursts of writes into one namespace change per freshness window.
 * Continuously posting organizations must not force every card back to a
 * cold calculation for each individual transaction. */
export const advanceSharedCacheVersion = (key: string, windowMs: number) => bounded(async () => (await getReadCacheConnection())?.eval(`
  if redis.call('SET', KEYS[1], '1', 'PX', ARGV[1], 'NX') then
    return redis.call('INCR', KEYS[2])
  end
  return tonumber(redis.call('GET', KEYS[2]) or '0')
`, 2, `${key}:change-window`, key, windowMs))

export async function claimSharedCache(key: string): Promise<string | null | undefined> {
  const token = randomUUID()
  const claimed = await bounded(async () => (await getReadCacheConnection())?.set(`${key}:lease`, token, 'PX', 90_000, 'NX'))
  return claimed === 'OK' ? token : claimed
}

/** Only the current lease owner may publish; an expired builder cannot replace
 * a newer result. Comparison, publication and lease release are atomic. */
export async function publishSharedCache(key: string, token: string, value: string, lifetimeMs: number): Promise<void> {
  await bounded(async () => (await getReadCacheConnection())?.eval(`
    if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
    redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[3])
    redis.call('DEL', KEYS[1])
    return 1
  `, 2, `${key}:lease`, key, token, value, lifetimeMs))
}

export async function releaseSharedCache(key: string, token: string): Promise<void> {
  await bounded(async () => (await getReadCacheConnection())?.eval(`
    if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
    return 0
  `, 1, `${key}:lease`, token))
}
