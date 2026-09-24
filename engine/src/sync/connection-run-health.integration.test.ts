/**
 * Connection health follows the run outcome.
 *
 * A mirror run that fails used to update only last_run_at on the connection,
 * leaving status healthy and last_error null — the operator saw a green
 * connection while the refusal lived only in sync_runs. A failed full run
 * now records the named refusal (status error + last_error), and the next
 * successful full run clears both fields back to healthy.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { runSync } from "./sync.ts";
import type { EntityStream, MigrationSource } from "./source.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

class FlakySource implements MigrationSource {
  readonly name = "qbo";
  readonly refKey = "qboId";
  readonly baseCurrency = "CAD";
  constructor(private readonly broken: boolean) {}

  accountingPeriods(): Promise<never[]> {
    return Promise.resolve([]);
  }

  async entities(): Promise<EntityStream[]> {
    return [];
  }

  nativeChanges(): Promise<{
    documents: [];
    applications: [];
    deletedRefs: [];
    syncedThrough: Date;
    unbuildable: [];
  }> {
    return Promise.resolve({
      documents: [],
      applications: [],
      deletedRefs: [],
      syncedThrough: new Date("2026-07-20T00:00:00.000Z"),
      unbuildable: [],
    });
  }

  trialBalance(): Promise<never[]> {
    if (this.broken) throw new Error("provider trial balance refused: connection token expired");
    return Promise.resolve([]);
  }

  monthlyActivity(): Promise<never[]> {
    return Promise.resolve([]);
  }

  openItems(): Promise<never[]> {
    return Promise.resolve([]);
  }
}

async function connectionHealth(orgId: string, connectionId: string) {
  const rows = (await db.execute<{ status: string; lastError: string | null }>(sql`
    select status, last_error as "lastError" from connections
     where id = ${connectionId} and org_id = ${orgId}`)).rows;
  return rows[0]!;
}

test(
  "a failing run marks the connection errored; the next success clears it",
  { skip: !DB, timeout: 180_000 },
  async () => {
    const org = await createScratchOrg();
    try {
      const connectionId = randomUUID();
      await db.execute(sql`
        insert into connections (id, org_id, source, display_name)
        values (${connectionId}, ${org.orgId}, 'qbo', 'run-health-test')`);

      await assert.rejects(
        runSync(new FlakySource(true), "run-health-test", {
          kind: "full_migration",
          orgId: org.orgId,
          connectionId,
          since: null,
        }),
        /connection token expired/,
      );
      const bad = await connectionHealth(org.orgId, connectionId);
      assert.equal(bad.status, "error");
      assert.match(bad.lastError ?? "", /connection token expired/);

      await runSync(new FlakySource(false), "run-health-test", {
        kind: "full_migration",
        orgId: org.orgId,
        connectionId,
        since: null,
      });
      const good = await connectionHealth(org.orgId, connectionId);
      assert.equal(good.status, "active");
      assert.equal(good.lastError, null);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
