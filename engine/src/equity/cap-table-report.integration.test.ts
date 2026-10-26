import assert from "node:assert/strict";
import test from "node:test";
import {
  BUILT_IN_REPORT_DEFINITION_MAP,
  REPORT_ENTITY_MAP,
  compileCustomQuery,
  runCustomQuery,
  validateCustomQuery,
} from "@openbooks/reports";
import { pool, withOrgContext } from "../platform/db.ts";
import { dropScratchOrgReporting } from "../testing/fixtures.ts";
import { seedPositionScenario, setupEquityWorld } from "../testing/equity-world.ts";
import { loadCapTableView } from "./read-model.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

interface Totals {
  outstanding: bigint;
  asConverted: bigint;
  awards: bigint;
  pool: bigint;
  fullyDiluted: bigint;
}

const ZERO: Totals = { outstanding: 0n, asConverted: 0n, awards: 0n, pool: 0n, fullyDiluted: 0n };
const isZero = (row: Totals) => Object.values(row).every((value) => value === 0n);
const add = (a: Totals, b: Totals): Totals => ({
  outstanding: a.outstanding + b.outstanding,
  asConverted: a.asConverted + b.asConverted,
  awards: a.awards + b.awards,
  pool: a.pool + b.pool,
  fullyDiluted: a.fullyDiluted + b.fullyDiluted,
});

test(
  "the Reports-hub cap table as of a date equals the replayed cap table by class, by holder and in total",
  { skip: !DB },
  async () => {
    const w = await setupEquityWorld();
    try {
      const scenario = await seedPositionScenario(w);
      const definition = BUILT_IN_REPORT_DEFINITION_MAP["equity-cap-table"];
      assert.ok(definition, "the built-in cap table report is registered");
      const entity = REPORT_ENTITY_MAP.equity_cap_table_positions!;
      assert.ok(
        scenario.checkDates.length > 0,
        "the scenario names the dates the cap table is checked on",
      );
      for (const asOf of scenario.checkDates) {
        // The as-of control's date is the plan's; the run's own business date never widens it.
        const query = validateCustomQuery({ ...definition.query, asOf });
        const compiled = compileCustomQuery(entity, query, w.org.orgId, { asOf: "2099-12-31" });
        const rows = await withOrgContext(
          w.org.orgId,
          async () =>
            (await pool.query(compiled.text, compiled.values)).rows as Record<string, unknown>[],
        );
        const byClass = new Map<string, Totals>();
        const byHolder = new Map<string, Totals>();
        let total = ZERO;
        for (const row of rows) {
          const figures: Totals = {
            outstanding: BigInt(String(row.m0)),
            asConverted: BigInt(String(row.m1)),
            awards: BigInt(String(row.m2)),
            pool: BigInt(String(row.m3)),
            fullyDiluted: BigInt(String(row.m4)),
          };
          byClass.set(String(row.d0), add(byClass.get(String(row.d0)) ?? ZERO, figures));
          if (row.d2 !== null)
            byHolder.set(String(row.d2), add(byHolder.get(String(row.d2)) ?? ZERO, figures));
          total = add(total, figures);
        }
        const view = await loadCapTableView({
          orgId: w.org.orgId,
          actorId: w.managerId,
          subsidiaryId: w.org.subsidiaryId,
          asOf,
        });
        const expectedClasses = new Map(
          view.table.classes
            .map(
              (row) =>
                [
                  row.code,
                  {
                    outstanding: BigInt(row.outstanding),
                    asConverted: BigInt(row.asConvertedOutstanding),
                    awards: BigInt(row.awardsOutstanding),
                    pool: BigInt(row.poolAvailable),
                    fullyDiluted: BigInt(row.fullyDiluted),
                  },
                ] as const,
            )
            .filter(([, row]) => !isZero(row)),
        );
        assert.deepEqual(
          new Map([...byClass].filter(([, row]) => !isZero(row))),
          expectedClasses,
          `classes on ${asOf}`,
        );
        const names = new Map([
          [w.holderId, "Founder One"],
          [scenario.investorId, "Seed Investor"],
        ]);
        const expectedHolders = new Map(
          view.table.holders
            .filter((row) => row.fullyDiluted !== "0")
            .map(
              (row) =>
                [
                  names.get(row.holderPartyId)!,
                  {
                    asConverted: BigInt(row.asConvertedOutstanding),
                    fullyDiluted: BigInt(row.fullyDiluted),
                  },
                ] as const,
            ),
        );
        const reportedHolders = new Map(
          [...byHolder]
            .filter(([, row]) => row.fullyDiluted !== 0n)
            .map(
              ([name, row]) =>
                [name, { asConverted: row.asConverted, fullyDiluted: row.fullyDiluted }] as const,
            ),
        );
        assert.deepEqual(reportedHolders, expectedHolders, `holders on ${asOf}`);
        assert.equal(
          total.outstanding,
          BigInt(view.table.totals.outstanding),
          `outstanding on ${asOf}`,
        );
        assert.equal(
          total.fullyDiluted,
          BigInt(view.table.totals.fullyDiluted),
          `fully diluted on ${asOf}`,
        );
        assert.equal(total.pool, BigInt(view.table.totals.poolAvailable), `pool on ${asOf}`);
      }
      // The shaped report path runs the same plan.
      const shaped = await withOrgContext(w.org.orgId, () =>
        runCustomQuery(
          pool,
          { ...definition.query, asOf: "2026-09-15" },
          {
            orgId: w.org.orgId,
            entityMap: REPORT_ENTITY_MAP,
            asOf: "2026-09-15",
          },
        ),
      );
      assert.ok(shaped.rowCount > 0);
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);
