import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

const testRedisUrl = process.env.OPENBOOKS_TEST_REDIS_URL

test('Redis lease renewal and publication enforce current ownership atomically', { skip: !testRedisUrl }, async t => {
  const previous = process.env.OPENBOOKS_REDIS_URL
  process.env.OPENBOOKS_REDIS_URL = testRedisUrl!
  const { getReadCacheConnection, closeJobConnections } = await import('./connection')
  const { claimSharedCache, renewSharedCache, publishSharedCache, releaseSharedCache } = await import('./read-cache')
  const key = `openbooks:analytics:lease-test:${randomUUID()}`
  const redis = await getReadCacheConnection()
  assert.ok(redis, 'the explicit test Redis must connect; unavailable infrastructure is a failed partition')
  t.after(async () => {
    try { await redis.del(key, `${key}:lease`) }
    finally {
      await closeJobConnections()
      if (previous === undefined) delete process.env.OPENBOOKS_REDIS_URL
      else process.env.OPENBOOKS_REDIS_URL = previous
    }
  })
  const token = await claimSharedCache(key)
  assert.ok(token)
  assert.equal(await claimSharedCache(key), null)
  await redis.pexpire(`${key}:lease`, 1000)
  await renewSharedCache(key, token)
  assert.ok(await redis.pttl(`${key}:lease`) > 80_000)
  await renewSharedCache(key, 'former-owner')
  assert.equal(await redis.get(`${key}:lease`), token)
  await publishSharedCache(key, 'former-owner', 'stale-result', 30_000)
  assert.equal(await redis.get(key), null)
  await releaseSharedCache(key, 'former-owner')
  assert.equal(await redis.get(`${key}:lease`), token)
  await publishSharedCache(key, token, 'current-result', 30_000)
  assert.equal(await redis.get(key), 'current-result')
  assert.equal(await redis.get(`${key}:lease`), null)
})
