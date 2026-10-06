import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

const testRedisUrl = process.env.OPENBOOKS_TEST_REDIS_URL

test('Redis lease renewal and publication enforce current ownership atomically', { skip: !testRedisUrl }, async t => {
  const resourceId = process.env.OPENBOOKS_TEST_REDIS_RESOURCE_ID
  assert.match(resourceId ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'the disposable Redis resource needs an explicit UUID identity')
  const previous = process.env.OPENBOOKS_REDIS_URL
  const { getReadCacheConnection, closeJobConnections } = await import('./connection')
  const { claimSharedCache, renewSharedCache, publishSharedCache, releaseSharedCache } = await import('./read-cache')
  const key = `openbooks:analytics:lease-test:${randomUUID()}`
  let redis: Awaited<ReturnType<typeof getReadCacheConnection>> | null = null
  let admitted = false
  t.after(async () => {
    try { if (admitted && redis) await redis.del(key, `${key}:lease`) }
    finally {
      try { await closeJobConnections() }
      finally {
        if (previous === undefined) delete process.env.OPENBOOKS_REDIS_URL
        else process.env.OPENBOOKS_REDIS_URL = previous
      }
    }
  })
  process.env.OPENBOOKS_REDIS_URL = testRedisUrl!
  redis = await getReadCacheConnection()
  assert.ok(redis, 'the explicit test Redis must connect; unavailable infrastructure is a failed partition')
  // Only disposable-service bootstrap writes this marker. The test first
  // reads it and refuses before any fixture mutation when identity differs.
  assert.equal(await redis.get('openbooks:test:disposable-resource'), resourceId, 'Redis is not the explicitly identified disposable test resource')
  admitted = true
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
