/**
 * One connection runs one sync of a kind at a time.
 *
 * The platform API guards ENQUEUE, but a BullMQ stalled re-delivery never
 * passes through it: when a worker's lock lapses -- a deploy rollout, or a tick
 * that outruns lockDuration -- the queue hands the same job to a second worker
 * while the first may still be writing. Production ran two concurrent NetSuite
 * full migrations over the same 50k documents that way, with one trigger id.
 *
 * These cases pin the claim: the second attempt is refused while a run is live,
 * a different kind is unaffected, and the claim is released once the live run
 * reaches a terminal status (which is also how the stale-run reaper unblocks a
 * connection whose worker died without writing one).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { createScratchOrg, type ScratchOrg } from "../test-fixtures.ts";
import { claimSyncRun, SyncRunAlreadyActiveError } from "./sync.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

let org: ScratchOrg | null = null;
async function ctx(): Promise<ScratchOrg> {
  if (!org) org = await createScratchOrg();
  return org;
}

async function newConnection(orgId: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into connections (id, org_id, source, display_name)
    values (${id}, ${orgId}, 'netsuite', ${`claim-test-${id.slice(0, 8)}`})`);
  return id;
}

function claim(orgId: string, connectionId: string, kind: string) {
  return claimSyncRun({
    orgId,
    connectionId,
    kind,
    sourceName: "netsuite",
    triggeredBy: "claim-test",
  });
}

test(
  "a second run of the same kind is refused while one is live, and admitted once it ends",
  { skip: !DB, timeout: 120_000 },
  async () => {
    const o = await ctx();
    const connectionId = await newConnection(o.orgId);

    const [first] = await claim(o.orgId, connectionId, "full_migration");
    assert.ok(first?.id, "the first claim takes the connection");

    // The stalled re-delivery: same connection, same kind, original still live.
    await assert.rejects(
      () => claim(o.orgId, connectionId, "full_migration"),
      (error: unknown) => error instanceof SyncRunAlreadyActiveError,
      "a duplicate full migration must be refused, not run alongside the first",
    );

    // A different kind is a different claim and must not be blocked.
    const [other] = await claim(o.orgId, connectionId, "incremental");
    assert.ok(other?.id, "an incremental run is a separate claim");

    // Terminal status releases the claim. This is also the path the stale-run
    // reaper uses to free a connection whose worker died mid-run.
    await db.execute(sql`
      update sync_runs set status = 'ok', finished_at = now()
       where id = ${first!.id} and org_id = ${o.orgId}`);
    const [resumed] = await claim(o.orgId, connectionId, "full_migration");
    assert.ok(resumed?.id, "the connection is claimable again once the live run ends");

    const live = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from sync_runs
       where org_id = ${o.orgId} and connection_id = ${connectionId}
         and kind = 'full_migration' and status = 'running'`);
    assert.equal(live.rows[0]!.n, 1, "never more than one live full migration per connection");
  },
);

test(
  "a claim on one connection does not block a different connection",
  { skip: !DB, timeout: 120_000 },
  async () => {
    const o = await ctx();
    const a = await newConnection(o.orgId);
    const b = await newConnection(o.orgId);

    const [onA] = await claim(o.orgId, a, "full_migration");
    assert.ok(onA?.id);
    const [onB] = await claim(o.orgId, b, "full_migration");
    assert.ok(onB?.id, "the guard is per connection, not per organization");
  },
);
