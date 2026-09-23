import test from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db, env, schema } from "../platform/db.ts";
import { sealJson } from "../platform/secrets.ts";
import { authenticateWebConnector, QBWC_AUTH_GUESS_WINDOW_S } from "./bridge.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";

const DB = Boolean(env.OPENBOOKS_DB_URL && env.OPENBOOKS_DATA_KEY);

// WAVE 9 (inbound authenticity): the Web Connector password is user-chosen
// (min 16 chars, typed into the desktop client), so authenticate must bound
// online guessing per connection — unlimited wrong passwords must not leave
// the correct password working, and one connection's flood must not lock out
// a sibling connection.
test("Web Connector password guessing is bounded per connection", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const connectionIds: string[] = [];
  try {
    const password = "guess-limit-test-password-123";
    for (const label of ["guess-flood", "guess-sibling"]) {
      const [connection] = await db.insert(schema.connections).values({
        orgId: org.orgId,
        source: "qbd",
        displayName: `QBD guess test ${label} ${Date.now()}`,
        authKind: "token",
        status: "active",
        config: { historyStartDate: "2026-01-01", region: "CA", baseCurrency: "CAD" },
        secrets: sealJson({ webConnectorPassword: password }),
      }).returning({ id: schema.connections.id });
      assert.ok(connection);
      connectionIds.push(connection.id);
    }
    const [floodId, siblingId] = connectionIds as [string, string];

    const baseline = await authenticateWebConnector(floodId, `qbd:${floodId}`, password);
    assert.ok(baseline.ticket, "correct password authenticates before the flood");

    for (let i = 0; i < 50; i += 1) {
      const bad = await authenticateWebConnector(floodId, `qbd:${floodId}`, `wrong-password-${i}`);
      assert.deepEqual(bad, { ticket: "", companyFile: "nvu" });
    }

    const locked = await authenticateWebConnector(floodId, `qbd:${floodId}`, password);
    assert.deepEqual(
      locked,
      { ticket: "", companyFile: "nvu" },
      "a password-guessing flood refuses even the correct password inside the window",
    );

    const sibling = await authenticateWebConnector(siblingId, `qbd:${siblingId}`, password);
    assert.ok(sibling.ticket, "a sibling connection still authenticates during the flood");
  } finally {
    for (const id of connectionIds) {
      await db.execute(sql`delete from qbd_sessions where connection_id = ${id}`);
      await db.execute(sql`delete from connections where id = ${id}`);
    }
    await db.execute(sql`delete from auth_rate_limit_buckets where bucket_key like 'qbwc:%'`);
    await dropScratchOrg(org.orgId);
  }
});

test("an expired guess window stops refusing the correct password", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  let connectionId = "";
  try {
    const password = "guess-window-expiry-password-123";
    const [connection] = await db.insert(schema.connections).values({
      orgId: org.orgId,
      source: "qbd",
      displayName: `QBD guess expiry test ${Date.now()}`,
      authKind: "token",
      status: "active",
      config: { historyStartDate: "2026-01-01", region: "CA", baseCurrency: "CAD" },
      secrets: sealJson({ webConnectorPassword: password }),
    }).returning({ id: schema.connections.id });
    assert.ok(connection);
    connectionId = connection.id;

    for (let i = 0; i < 50; i += 1) {
      const bad = await authenticateWebConnector(connectionId, `qbd:${connectionId}`, `wrong-password-${i}`);
      assert.deepEqual(bad, { ticket: "", companyFile: "nvu" });
    }
    const locked = await authenticateWebConnector(connectionId, `qbd:${connectionId}`, password);
    assert.deepEqual(locked, { ticket: "", companyFile: "nvu" }, "in-window flood refuses the correct password");

    // Age the bucket past the window: the trip must lapse with the window.
    await db.execute(sql`
      update auth_rate_limit_buckets set window_started_at = now() - (${QBWC_AUTH_GUESS_WINDOW_S + 1} * interval '1 second')
       where bucket_key = ${`qbwc:${connectionId}`}`);
    const recovered = await authenticateWebConnector(connectionId, `qbd:${connectionId}`, password);
    assert.ok(recovered.ticket, "the correct password authenticates once the guess window expires");

    // A fresh flood inside the new window still locks out.
    for (let i = 0; i < 50; i += 1) {
      await authenticateWebConnector(connectionId, `qbd:${connectionId}`, `wrong-password-again-${i}`);
    }
    const relocked = await authenticateWebConnector(connectionId, `qbd:${connectionId}`, password);
    assert.deepEqual(relocked, { ticket: "", companyFile: "nvu" }, "an in-window flood still refuses the correct password");
  } finally {
    if (connectionId) {
      await db.execute(sql`delete from qbd_sessions where connection_id = ${connectionId}`);
      await db.execute(sql`delete from connections where id = ${connectionId}`);
      await db.execute(sql`delete from auth_rate_limit_buckets where bucket_key = ${`qbwc:${connectionId}`}`);
    }
    await dropScratchOrg(org.orgId);
  }
});
