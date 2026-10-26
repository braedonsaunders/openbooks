import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { dropScratchOrgReporting } from "../testing/fixtures.ts";
import {
  nonZero,
  replayedPositions,
  seedPositionScenario,
  setupEquityWorld,
} from "../testing/equity-world.ts";
import { ledgerPositions, syncPositionLedger } from "./positions.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

type Positions = Map<string, { shares: bigint; asConverted: bigint }>;

/** Prefix sums of movement rows through a date, keyed like the ledger. */
function sumThrough(
  rows: readonly {
    security_id: string | null;
    plan_id: string | null;
    effective_on: string;
    shares_delta: string;
    as_converted_delta: string;
  }[],
  on: string,
): Positions {
  const positions: Positions = new Map();
  for (const row of rows) {
    if (row.effective_on > on) continue;
    const key = row.plan_id ? `p:${row.plan_id}` : `s:${row.security_id}`;
    const at = positions.get(key) ?? { shares: 0n, asConverted: 0n };
    positions.set(key, {
      shares: at.shares + BigInt(row.shares_delta),
      asConverted: at.asConverted + BigInt(row.as_converted_delta),
    });
  }
  return nonZero(positions);
}

test(
  "the position ledger summed through any date is the replayed cap table, through an exercise, a reversal, a split and a void",
  { skip: !DB },
  async () => {
    const w = await setupEquityWorld();
    try {
      const scenario = await seedPositionScenario(w);
      assert.ok(
        scenario.checkDates.length > 0,
        "the scenario names the dates the cap table is checked on",
      );
      for (const on of scenario.checkDates) {
        assert.deepEqual(
          nonZero(await ledgerPositions(db, w.org.orgId, w.org.subsidiaryId, on)),
          nonZero(await replayedPositions(w, on)),
          `the ledger is the cap table on ${on}`,
        );
      }
      // The split restates the founder's common and doubles the preferred's common equivalent.
      const afterSplit = await ledgerPositions(db, w.org.orgId, w.org.subsidiaryId, "2026-09-01");
      assert.deepEqual(afterSplit.get(`s:${scenario.founderSharesId}`), {
        shares: 2_000_000n,
        asConverted: 2_000_000n,
      });
      assert.deepEqual(afterSplit.get(`s:${scenario.preferredSharesId}`), {
        shares: 500_000n,
        asConverted: 1_000_000n,
      });
      // The void of the exercise certificate returns its units to the option from the void date.
      const beforeVoid = await ledgerPositions(db, w.org.orgId, w.org.subsidiaryId, "2026-09-14");
      const afterVoid = await ledgerPositions(db, w.org.orgId, w.org.subsidiaryId, "2026-09-15");
      assert.equal(beforeVoid.get(`s:${scenario.exerciseCertificateId}`)?.shares, 200n);
      assert.equal(afterVoid.get(`s:${scenario.exerciseCertificateId}`)?.shares ?? 0n, 0n);
      assert.equal(
        afterVoid.get(`s:${scenario.optionId}`)!.shares -
          beforeVoid.get(`s:${scenario.optionId}`)!.shares,
        200n,
      );

      // Reconciling again appends nothing: the ledger already matches the replay.
      const rows = Number(
        (
          await db.execute<{ n: string }>(
            sql`select count(*)::text as n from equity_position_movements where org_id = ${w.org.orgId}`,
            "objects",
          )
        )[0]!.n,
      );
      assert.equal(
        await withOrgTransaction(w.org.orgId, () =>
          syncPositionLedger(db, w.org.orgId, w.org.subsidiaryId),
        ),
        0,
      );
      assert.equal(
        Number(
          (
            await db.execute<{ n: string }>(
              sql`select count(*)::text as n from equity_position_movements where org_id = ${w.org.orgId}`,
              "objects",
            )
          )[0]!.n,
        ),
        rows,
      );
      // Movements are retained history.
      await assert.rejects(
        db.execute(
          sql`update equity_position_movements set shares_delta = shares_delta + 1 where org_id = ${w.org.orgId}`,
        ),
      );
      await assert.rejects(
        db.execute(sql`delete from equity_position_movements where org_id = ${w.org.orgId}`),
      );
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);

test(
  "the migration's backfill computes the same positions from recorded history as the replay",
  { skip: !DB },
  async () => {
    const w = await setupEquityWorld();
    try {
      const scenario = await seedPositionScenario(w);
      const rows = await db.execute<{
        security_id: string | null;
        plan_id: string | null;
        effective_on: string;
        shares_delta: string;
        as_converted_delta: string;
      }>(
        sql`
      select security_id, plan_id, effective_on::text as effective_on, shares_delta::text as shares_delta, as_converted_delta::text as as_converted_delta
        from public.equity_position_backfill(${w.org.orgId}::uuid, ${w.org.subsidiaryId}::uuid, false)`,
        "objects",
      );
      assert.ok(rows.length > 0);
      assert.ok(
        scenario.checkDates.length > 0,
        "the scenario names the dates the cap table is checked on",
      );
      for (const on of scenario.checkDates) {
        assert.deepEqual(
          sumThrough(rows, on),
          nonZero(await replayedPositions(w, on)),
          `the backfill is the cap table on ${on}`,
        );
      }
      // An entity whose ledger is already written is never backfilled twice.
      await assert.rejects(
        db.execute(
          sql`select count(*) from public.equity_position_backfill(${w.org.orgId}::uuid, ${w.org.subsidiaryId}::uuid, true)`,
        ),
      );
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);
