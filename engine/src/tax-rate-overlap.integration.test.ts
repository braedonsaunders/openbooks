import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { PoolClient, QueryResult } from "pg";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db, pool } from "./db.ts";
import { createScratchOrg, dropScratchOrg } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Storage-enforced tax-rate effective-window exclusivity.
 *
 * The BEFORE trigger `tax_rates_no_overlap_guard` validates against committed
 * rows only. Under READ COMMITTED two transactions writing overlapping
 * inclusive windows were mutually invisible, so both passed their guard and
 * committed parallel statutory configuration; loadTaxComponentConfig then
 * resolved the winner with a nondeterministic ORDER BY effective_from DESC
 * LIMIT 1. Migration 0024 adds `tax_rates_effective_range_exclusion`, a GiST
 * exclusion constraint over (org_id, tax_code_id,
 * daterange(effective_from, COALESCE(effective_to,'infinity'::date),'[]')),
 * mirroring effective_date_ranges_overlap exactly — including open-ended
 * rates.
 *
 * Every scenario interleaves two real sessions on live PostgreSQL: writer A
 * holds an uncommitted overlapping state inside an explicit transaction while
 * writer B races its statement through independent autocommit writes. With
 * the constraint present B cannot settle while A is unresolved — the index
 * arbitrates the conflict — and once A commits, B fails with SQLSTATE 23P01.
 * Adjacent controls prove the constraint accepts exactly what
 * effective_date_ranges_overlap accepts: same interleaving, zero-overlap
 * windows, both writers land.
 */

// An allowed write settles in single-digit milliseconds. A conflicting write
// stays pending until A resolves, so any observed stall inside this window is
// storage-level conflict arbitration rather than scheduler noise.
const ARBITRATION_WINDOW_MS = 5_000;

type PgError = Error & { code?: string; constraint?: string };

type Outcome =
  | { kind: "ok"; result: QueryResult }
  | { kind: "error"; error: PgError };

const insertRate = `
  insert into tax_rates (org_id, tax_code_id, rate_percent, effective_from, effective_to)
  values ($1, $2, $3::numeric, $4::date, $5::date)
  returning id`;

/**
 * Launch one racing write as its own autocommit transaction with RLS bypassed
 * (the pool applies the trusted-test resolver per checkout). Pending until it
 * lands; a conflicting writer parks on the index until the first writer
 * resolves or aborts.
 */
function raceWrite(text: string, params: unknown[]): Promise<Outcome> {
  return pool.query(text, params).then(
    (result) => ({ kind: "ok", result } satisfies Outcome),
    (error) => ({ kind: "error", error: error as PgError } satisfies Outcome),
  );
}

async function stillPending(promise: Promise<unknown>, windowMs: number): Promise<boolean> {
  let pending = true;
  void promise.finally(() => {
    pending = false;
  });
  await Promise.race([promise, new Promise((resolve) => setTimeout(resolve, windowMs))]);
  return pending;
}

function assertExcluded(expectation: string, outcome: Outcome): void {
  if (outcome.kind !== "error") {
    assert.fail(`${expectation} had to fail at storage enforcement`);
  }
  assert.equal(
    outcome.error.code,
    "23P01",
    `expected exclusion violation, got ${outcome.error.message}`,
  );
  assert.match(
    outcome.error.message,
    /tax_rates_effective_range_exclusion/,
    "the failure must come from the storage-side exclusion constraint",
  );
}

async function rateCount(client: PoolClient | typeof pool, taxCodeId: string): Promise<number> {
  const result = await client.query<{ count: string }>(
    "select count(*)::text as count from tax_rates where tax_code_id = $1",
    [taxCodeId],
  );
  return Number(result.rows[0]!.count);
}

test("concurrent tax-rate writes may not commit overlapping effective windows", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const clientA = await pool.connect();
  let aTxnOpen = false;

  // An explicit-transaction session must never rejoin the pool while its
  // transaction survived an assertion failure mid-scenario.
  async function settleWriterA(): Promise<void> {
    if (!aTxnOpen) return;
    aTxnOpen = false;
    await clientA.query("rollback").catch(() => {});
  }

  try {
    // One code per scenario keeps evidence unambiguous: every violation below
    // can only belong to that scenario's own identity lane.
    const laneRows = await db.execute<{ code: string; id: string }>(sql`
      insert into tax_codes (id, org_id, code, name)
      values (${randomUUID()}, ${org.orgId}, 'OV-ADJ', 'Adjacent-window probe'),
             (${randomUUID()}, ${org.orgId}, 'OV-CC', 'Concurrent-create probe'),
             (${randomUUID()}, ${org.orgId}, 'OV-LANE', 'Identity-lane probe'),
             (${randomUUID()}, ${org.orgId}, 'OV-UC', 'Update-then-create probe'),
             (${randomUUID()}, ${org.orgId}, 'OV-UA', 'Abort-releases-loser probe'),
             (${randomUUID()}, ${org.orgId}, 'OV-TRG', 'Preflight-message probe')
      returning code, id`);
    const laneByCode = new Map(laneRows.rows.map((row) => [row.code, row.id]));
    function lane(code: string): string {
      const taxCodeId = laneByCode.get(code);
      assert.ok(taxCodeId, `identity lane ${code} was seeded`);
      return taxCodeId!;
    }

    // ------------------------------------------------------------------
    // Control: two ADJACENT inclusive windows under the same held-open
    // interleaving must BOTH land. Without this, a constraint that rejects
    // every write would also look fixed.
    // ------------------------------------------------------------------
    await clientA.query("begin");
    aTxnOpen = true;
    await clientA.query(insertRate, [org.orgId, lane("OV-ADJ"), "13.0000", "2026-01-01", "2026-06-30"]);
    const adjacentB = raceWrite(insertRate, [org.orgId, lane("OV-ADJ"), "5.0000", "2026-07-01", "2026-12-31"]);
    assert.equal(
      await stillPending(adjacentB, ARBITRATION_WINDOW_MS),
      false,
      "an adjacent window must not be arbitrated against the held-open writer",
    );
    const adjacentOutcome = await adjacentB;
    assert.equal(adjacentOutcome.kind, "ok", "adjacent non-overlapping windows are product-valid");
    await clientA.query("commit");
    aTxnOpen = false;
    assert.equal(await rateCount(clientA, lane("OV-ADJ")), 2);

    // ------------------------------------------------------------------
    // CREATE + CREATE of overlapping windows. Exactly one row survives; the
    // loser parks on the index until A commits, then fails with 23P01. A
    // different tax code holding the identical window is a different
    // identity lane and must not be collateral damage of that arbitration.
    // ------------------------------------------------------------------
    await clientA.query("begin");
    aTxnOpen = true;
    await clientA.query(insertRate, [org.orgId, lane("OV-CC"), "13.0000", "2026-01-01", "2026-06-30"]);
    const createLoser = raceWrite(insertRate, [org.orgId, lane("OV-CC"), "13.0000", "2026-03-01", "2026-12-31"]);
    const foreignLane = raceWrite(insertRate, [org.orgId, lane("OV-LANE"), "13.0000", "2026-01-01", "2026-06-30"]);
    assert.equal(
      await stillPending(createLoser, ARBITRATION_WINDOW_MS),
      true,
      "the overlapping create was accepted while the first window's transaction was still open",
    );
    assert.equal(
      await stillPending(foreignLane, ARBITRATION_WINDOW_MS),
      false,
      "a foreign identity lane must not be arbitrated against another lane's window",
    );
    const foreignLaneOutcome = await foreignLane;
    assert.equal(foreignLaneOutcome.kind, "ok", "a foreign identity lane must not be collateral damage");
    await clientA.query("commit");
    aTxnOpen = false;

    const createLoserOutcome = await createLoser;
    assertExcluded("a second overlapping create", createLoserOutcome);
    assert.equal(await rateCount(clientA, lane("OV-CC")), 1);
    assert.equal(await rateCount(clientA, lane("OV-LANE")), 1);

    // ------------------------------------------------------------------
    // UPDATE extends a committed row to be open-ended while a CREATE races
    // what would have been an ADJACENT window against the old snapshot. The
    // preflight reads only committed rows (no overlap there); storage
    // arbitrates against the in-flight extension instead.
    // ------------------------------------------------------------------
    const extendedRow = (
      await clientA.query<{ id: string }>(insertRate, [
        org.orgId,
        lane("OV-UC"),
        "13.0000",
        "2026-01-01",
        "2026-06-30",
      ])
    ).rows[0]!.id;
    await clientA.query("begin");
    aTxnOpen = true;
    await clientA.query("update tax_rates set effective_to = null where id = $1", [extendedRow]);
    const updateCreateLoser = raceWrite(insertRate, [
      org.orgId,
      lane("OV-UC"),
      "5.0000",
      "2026-07-01",
      "2026-12-31",
    ]);
    assert.equal(
      await stillPending(updateCreateLoser, ARBITRATION_WINDOW_MS),
      true,
      "the racing create did not observe the in-flight open-ended extension",
    );
    await clientA.query("commit");
    aTxnOpen = false;

    assertExcluded(
      "a create shadowed by an extended open-ended rate",
      await updateCreateLoser,
    );
    assert.equal(await rateCount(clientA, lane("OV-UC")), 1);

    // Mirror image of the same arbitration: when the first writer ABORTS,
    // the blocked window becomes representable and commits immediately.
    const doomedRow = (
      await clientA.query<{ id: string }>(insertRate, [
        org.orgId,
        lane("OV-UA"),
        "13.0000",
        "2026-01-01",
        "2026-06-30",
      ])
    ).rows[0]!.id;
    await clientA.query("begin");
    aTxnOpen = true;
    await clientA.query("update tax_rates set effective_to = null where id = $1", [doomedRow]);
    const releasedWinner = raceWrite(insertRate, [
      org.orgId,
      lane("OV-UA"),
      "5.0000",
      "2026-07-01",
      "2026-12-31",
    ]);
    assert.equal(
      await stillPending(releasedWinner, ARBITRATION_WINDOW_MS),
      true,
      "the racing create should have parked on the uncommitted extension",
    );
    await clientA.query("rollback");
    aTxnOpen = false;
    const releasedOutcome = await releasedWinner;
    assert.equal(releasedOutcome.kind, "ok", "an aborted first writer must release the loser's window");
    assert.equal(await rateCount(clientA, lane("OV-UA")), 2);

    // ------------------------------------------------------------------
    // The preflight trigger stays authoritative where it CAN see the
    // conflict: a serial duplicate reaches it before storage and still
    // answers with the product's readable message rather than a bare
    // constraint name.
    // ------------------------------------------------------------------
    await pool.query(insertRate, [org.orgId, lane("OV-TRG"), "13.0000", "2026-01-01", "2026-06-30"]);
    const serialDuplicateError = await pool
      .query(insertRate, [org.orgId, lane("OV-TRG"), "13.0000", "2026-01-01", "2026-06-30"])
      .then(
        () => null as PgError | null,
        (error) => error as PgError,
      );
    assert.ok(serialDuplicateError, "a duplicate overlapping window must still be rejected");
    assert.equal(serialDuplicateError.code, "23P01");
    assert.match(serialDuplicateError.message, /tax rates overlap for tax code/);
  } finally {
    await settleWriterA();
    clientA.release();
    await dropScratchOrg(org.orgId);
  }
});

