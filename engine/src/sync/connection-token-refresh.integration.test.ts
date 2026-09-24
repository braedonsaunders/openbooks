import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { sealJson, unsealJson } from "../platform/secrets.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { refreshConnectionTokens } from "./connection.ts";

process.env.OPENBOOKS_DATA_KEY ??=
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

test("concurrent token refreshes use the newest generation and preserve current app credentials", async () => {
  const org = await createScratchOrg();
  const id = randomUUID();
  const consumed = {
    accessToken: "expired-access",
    refreshToken: "rotating-refresh-v1",
    expiresAt: "2020-01-01T00:00:00.000Z",
  };
  try {
    await db.execute(sql`
      insert into connections (id, org_id, source, display_name, status, auth_kind, secrets)
      values (${id}, ${org.orgId}, 'xero', 'refresh-race', 'active', 'oauth2', ${sealJson({
        clientId: "client-before-admin-rotation",
        clientSecret: "secret-before-admin-rotation",
        ...consumed,
      })})`);
    // Simulate an administrator rotating app credentials after this worker
    // built its client, but before its expired-token callback begins.
    await db.execute(sql`
      update connections set secrets = ${sealJson({
        clientId: "current-client-id",
        clientSecret: "current-client-secret",
        tenantId: "current-tenant",
        ...consumed,
      })}
       where id = ${id} and org_id = ${org.orgId}`);

    let refreshCalls = 0;
    const refresh = async (refreshToken: string) => {
      refreshCalls++;
      assert.equal(refreshToken, "rotating-refresh-v1");
      await new Promise((resolve) => setTimeout(resolve, 30));
      return {
        accessToken: "rotated-access-v2",
        refreshToken: "rotating-refresh-v2",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    };
    const connection = { id, orgId: org.orgId };
    const [first, second] = await Promise.all([
      refreshConnectionTokens(connection, consumed, refresh),
      refreshConnectionTokens(connection, consumed, refresh),
    ]);

    assert.equal(refreshCalls, 1, "only one worker may consume the rotating refresh token");
    assert.deepEqual(second, first, "the waiting worker adopts the committed token generation");
    const loaded = await db.execute<{ secrets: string | null }>(sql`
      select secrets from connections where id = ${id} and org_id = ${org.orgId}`);
    const stored = unsealJson<Record<string, unknown>>(String(loaded.rows[0]?.secrets));
    assert.ok(stored, "the latest sealed credentials remain readable");
    assert.equal(stored.clientId, "current-client-id");
    assert.equal(stored.clientSecret, "current-client-secret");
    assert.equal(stored.tenantId, "current-tenant");
    assert.equal(stored.refreshToken, "rotating-refresh-v2");
    assert.equal(stored.accessToken, "rotated-access-v2");
  } finally {
    await db.execute(sql`delete from connections where id = ${id} and org_id = ${org.orgId}`);
    await dropScratchOrg(org.orgId);
  }
});
