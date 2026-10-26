import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

test(
  "Redis lease renewal and publication enforce current ownership atomically",
  { skip: !process.env.OPENBOOKS_REDIS_URL },
  async (t) => {
    const { getReadCacheConnection, closeJobConnections } = await import("./connection");
    const { claimSharedCache, renewSharedCache, publishSharedCache, releaseSharedCache } =
      await import("./read-cache");
    const key = `openbooks:analytics:lease-test:${randomUUID()}`;
    let redis: Awaited<ReturnType<typeof getReadCacheConnection>> | null = null;
    let admitted = false;
    t.after(async () => {
      try {
        if (admitted && redis) await redis.del(key, `${key}:lease`);
      } finally {
        await closeJobConnections();
      }
    });
    redis = await getReadCacheConnection();
    assert.ok(
      redis,
      "the configured Redis must connect; unavailable infrastructure is a failed partition",
    );
    // Every write uses this invocation's random namespace; cleanup cannot touch another cache owner.
    admitted = true;
    const token = await claimSharedCache(key);
    assert.ok(token);
    assert.equal(await claimSharedCache(key), null);
    await redis.pexpire(`${key}:lease`, 1000);
    await renewSharedCache(key, token);
    assert.ok((await redis.pttl(`${key}:lease`)) > 80_000);
    await renewSharedCache(key, "former-owner");
    assert.equal(await redis.get(`${key}:lease`), token);
    await publishSharedCache(key, "former-owner", "stale-result", 30_000);
    assert.equal(await redis.get(key), null);
    await releaseSharedCache(key, "former-owner");
    assert.equal(await redis.get(`${key}:lease`), token);
    await publishSharedCache(key, token, "current-result", 30_000);
    assert.equal(await redis.get(key), "current-result");
    assert.equal(await redis.get(`${key}:lease`), null);
  },
);
