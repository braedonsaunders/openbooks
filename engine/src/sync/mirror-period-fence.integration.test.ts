import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { syncSourceAccountingPeriods } from "./migrate.ts";
import type { MigrationSource, SourceEntity } from "./source.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One closed period mirroring the scratch org's own open period. */
function closedPeriodSource(period: {
  fiscalYear: number;
  periodNumber: number;
  name: string;
  startsOn: string;
  endsOn: string;
}): MigrationSource {
  const record: SourceEntity = {
    sourceRef: "PER-1",
    fields: {
      fiscalYear: period.fiscalYear,
      periodNumber: period.periodNumber,
      name: period.name,
      startsOn: period.startsOn,
      endsOn: period.endsOn,
      closed: true,
      closedAt: period.endsOn,
    },
  };
  return {
    name: "fence-test",
    refKey: "fenceTestId",
    baseCurrency: "CAD",
    accountingPeriods: async () => [record],
    entities: async () => [],
    nativeChanges: async () => {
      throw new Error("not used by this test");
    },
    trialBalance: async () => [],
    monthlyActivity: async () => [],
  };
}

/** Resolves once a backend other than this one parks inside an advisory lock. */
async function waitForAdvisoryPark(): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const parked = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n
        from pg_stat_activity
       where datname = current_database()
         and pid <> pg_backend_pid()
         and wait_event_type = 'Lock'
         and query like '%pg_advisory_xact_lock%'
    `)).rows[0]!.n;
    if (parked > 0) return;
    assert.ok(Date.now() < deadline, "timed out waiting for the mirror to take the fence");
    await sleep(100);
  }
}

async function importedLockCount(orgId: string, periodId: string): Promise<number> {
  const rows = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from period_locks
     where org_id = ${orgId} and period_id = ${periodId}
       and reason = 'close.importedPeriodLockReason'
  `)).rows[0]!.n;
  return rows;
}

test("the period mirror takes the 0022 exclusive fence before writing lock rows", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const brake = new pg.Client({ connectionString: process.env.OPENBOOKS_DB_URL });
  try {
    const period = (await db.execute<{
        fiscal_year: number; period_number: number; name: string; starts_on: string; ends_on: string;
      }>(sql`
      select fiscal_year, period_number, name, starts_on::text, ends_on::text
        from accounting_periods where id = ${org.periodId} and org_id = ${org.orgId}
    `)).rows[0]!;
    const fenceKey = `period-lock:${org.orgId}:${org.periodId}:${org.bookId}`;

    // Parking brake on the exclusive side of the close/posting fence. A
    // mirror that takes the fence must block here before writing anything;
    // one that does not sails through and commits lock rows underneath us.
    await brake.connect();
    await brake.query(`select pg_advisory_lock(hashtextextended($1, 0))`, [fenceKey]);
    let settled = false;
    const sync = syncSourceAccountingPeriods(
      closedPeriodSource({
        fiscalYear: period.fiscal_year,
        periodNumber: period.period_number,
        name: period.name,
        startsOn: period.starts_on,
        endsOn: period.ends_on,
      }),
      org.orgId,
    ).then(
      (stats) => {
        settled = true;
        return stats;
      },
      (error) => {
        settled = true;
        throw error;
      },
    );

    const winner = await Promise.race([
      sync.then(() => "settled" as const),
      waitForAdvisoryPark().then(() => "parked" as const),
    ]);
    assert.equal(
      winner,
      "parked",
      "mirror wrote period locks without taking the 0022 exclusive fence",
    );
    assert.equal(settled, false);
    assert.equal(await importedLockCount(org.orgId, org.periodId), 0);

    await brake.query(`select pg_advisory_unlock(hashtextextended($1, 0))`, [fenceKey]);
    const stats = await sync;
    assert.equal(stats.created + stats.updated, 1);
    const gl = (await db.execute<{ state: string; reason: string }>(sql`
      select state, reason from period_locks
       where org_id = ${org.orgId} and period_id = ${org.periodId}
         and book_id = ${org.bookId} and subsidiary_id is null and module = 'gl'
    `)).rows[0]!;
    assert.equal(gl.state, "closed");
    assert.equal(gl.reason, "close.importedPeriodLockReason");
  } finally {
    await brake.end().catch(() => undefined);
    await dropScratchOrg(org.orgId);
  }
});
