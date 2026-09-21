import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { add, formatMoney } from "../money/money.ts";
import { db, withBypassContext, withOrgContext } from "../platform/db.ts";
import { runTaxPool, TaxPoolError } from "./pool-run.ts";
import {
  ensureTaxYearWindow,
  taxYearWindowDeleteProblem,
  taxYearWindowWriteProblem,
} from "./macrs-calendar.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedApprovalFlow,
  seedFlowActors,
  type FlowActors,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { submitFinancialChange } from "../flows/financial-changes-adapter.ts";
import { decideGate } from "../flows/gates.ts";
import { buildSchedule } from "../assets/depreciation.ts";
import { applyAssetChange, proposeAssetChange } from "../assets/asset-changes.ts";
import {
  applyTaxAssetBasis,
  applyTaxAssetBasisReversal,
  listTaxAssetBasisSources,
  proposeTaxAssetBasis,
  proposeTaxAssetBasisReversal,
  TaxAssetBasisError,
} from "./asset-basis-workpaper.ts";
import {
  applyTaxMatchingReplay,
  previewTaxMatchingReplay,
  proposeTaxMatchingReplay,
} from "./consolidated-matching-replay.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

// A scratch org (country CA) plus its primary book / root subsidiary / admin
// actor — the exact scope one runTaxPool call fences and writes.
async function seededOrg(): Promise<{ org: ScratchOrg; actorId: string }> {
  const org = await createScratchOrg();
  const { adminId } = await seedFlowActors(org.orgId);
  return { org, actorId: adminId };
}

async function seedTaxCategory(
  org: ScratchOrg,
  name: string,
  taxAttributes: Record<string, string>,
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into asset_categories
      (id, org_id, name, asset_account_id, accumulated_depreciation_account_id,
       depreciation_expense_account_id, default_method, tax_attributes, is_active)
    values (${id}, ${org.orgId}, ${name}, ${org.accounts.invAsset},
            ${org.accounts.adjustment}, ${org.accounts.freight}, 'straight_line',
            ${JSON.stringify(taxAttributes)}::jsonb, true)`);
  return id;
}

async function seedAsset(
  org: ScratchOrg,
  actorId: string,
  categoryId: string,
  cost: string,
  acquiredOn: string,
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into fixed_assets
      (id, org_id, subsidiary_id, category_id, asset_number, name, status,
       acquired_on, in_service_on, acquisition_cost, created_by, updated_by)
    values (${id}, ${org.orgId}, ${org.subsidiaryId}, ${categoryId}, ${`FA-${id.slice(0, 8)}`},
            ${`Asset ${id.slice(0, 8)}`}, 'in_service', ${acquiredOn}, ${acquiredOn},
            ${cost}, ${actorId}, ${actorId})`);
  return id;
}

async function seedDisposalEvent(
  org: ScratchOrg,
  actorId: string,
  assetId: string,
  occurredOn: string,
  amount: string,
): Promise<void> {
  await db.execute(sql`
    insert into asset_events (org_id, asset_id, kind, occurred_on, amount, created_by, updated_by)
    values (${org.orgId}, ${assetId}, 'disposed', ${occurredOn}, ${amount}, ${actorId}, ${actorId})`);
  // The run must derive historical ownership from the dated event, not this
  // mutable present-day status (which is what a real disposal workflow sets).
  await db.execute(sql`update fixed_assets set status = 'disposed', updated_by = ${actorId} where org_id = ${org.orgId} and id = ${assetId}`);
}

/** Tenant-defined pool class (e.g. a code the built-in regime doesn't ship). */
async function seedPoolClass(org: ScratchOrg, classCode: string): Promise<void> {
  await db.execute(sql`
    insert into tax_pool_classes (id, org_id, regime, class_code, name, rate, is_active)
    values (${randomUUID()}, ${org.orgId}, 'ca_cca', ${classCode}, ${`Tenant class ${classCode}`}, '0.1000000000', true)`);
}

interface RunScope {
  orgId: string;
  bookId: string;
  subsidiaryId: string;
}

async function declareYear(
  scope: RunScope,
  actorId: string,
  regime: string,
  taxYear: number,
  yearStart = `${taxYear}-01-01`,
  yearEnd = `${taxYear}-12-31`,
) {
  return ensureTaxYearWindow(db, scope.orgId, actorId, {
    subsidiaryId: scope.subsidiaryId,
    regime,
    yearStart,
    yearEnd,
    filingYear: taxYear,
    reason: "calendar-year tax window",
  });
}

const runYear = async (
  scope: RunScope,
  actorId: string,
  regime: string,
  taxYear: number,
) => {
  await declareYear(scope, actorId, regime, taxYear);
  return runTaxPool(scope.orgId, scope.bookId, scope.subsidiaryId, regime, taxYear, {
    yearStart: `${taxYear}-01-01`,
    yearEnd: `${taxYear}-12-31`,
    actorId,
  });
};

type PeriodRow = {
  pool_id: string;
  tax_year: number;
  opening_balance: string;
  additions: string;
  allowance: string;
  closing_balance: string;
  recapture: string;
  terminal_loss: string;
};

const periodsFor = async (orgId: string): Promise<PeriodRow[]> =>
  (await db.execute<PeriodRow>(sql`
    select pp.pool_id, pp.tax_year, pp.opening_balance::text, pp.additions::text,
           pp.allowance::text, pp.closing_balance::text, pp.recapture::text, pp.terminal_loss::text
      from tax_pool_periods pp
     where pp.org_id = ${orgId}
     order by pp.pool_id, pp.tax_year`)).rows;

type PoolRow = {
  id: string;
  class_code: string;
  opening_balance: string;
};

const poolsFor = async (orgId: string): Promise<PoolRow[]> =>
  (await db.execute<PoolRow>(sql`
    select id, class_code, opening_balance::text
      from tax_depreciation_pools
     where org_id = ${orgId}
     order by class_code`)).rows;

test("unknown pool and MACRS class codes fail closed without persisting a partial run", { skip: !DB }, async () => {
  const { org, actorId } = await seededOrg();
  try {
    const categoryId = await seedTaxCategory(org, "Unmapped tax asset", {
      ca_cca_class: "tenant_typo",
      us_macrs_class: "tenant_typo",
    });
    await seedAsset(org, actorId, categoryId, "10000.00", "2023-05-01");

    await assert.rejects(
      runYear(org, actorId, "ca_cca", 2023),
      (error: unknown) => error instanceof TaxPoolError && /unknown tax class.*tenant_typo/.test(error.message),
    );
    assert.equal((await periodsFor(org.orgId)).length, 0, "unknown pool class leaves no period behind");
    assert.equal((await poolsFor(org.orgId)).length, 0, "unknown pool class leaves no pool behind");

    await assert.rejects(
      runYear(org, actorId, "us_macrs", 2023),
      (error: unknown) => error instanceof TaxPoolError && /unknown tax class.*tenant_typo/.test(error.message),
    );
    assert.equal((await periodsFor(org.orgId)).length, 0, "unknown MACRS class leaves no period behind");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("Canadian vehicle cost caps apply to additions and disposition capital cost per asset", { skip: !DB }, async () => {
  const { org, actorId } = await seededOrg();
  try {
    const categoryId = await seedTaxCategory(org, "Passenger vehicle", { ca_cca_class: "10.1" });
    const assetId = await seedAsset(org, actorId, categoryId, "60000.00", "2023-05-01");

    const first = await runYear(org, actorId, "ca_cca", 2023);
    assert.deepEqual(first.lines.map((line) => [line.classCode, line.additions, line.allowance, line.closingBalance]), [
      ["10.1", "37000.00", "5550.00", "31450.00"],
    ]);

    // Legacy disposeAsset path: no financial_change_id. The run must keep
    // lesser-of-proceeds-and-class-cap and must not demand a workpaper.
    await seedDisposalEvent(org, actorId, assetId, "2024-05-01", "60000.00");
    const second = await runYear(org, actorId, "ca_cca", 2024);
    assert.deepEqual(second.lines.map((line) => [line.classCode, line.dispositions, line.recapture, line.closingBalance]), [
      ["10.1", "37000.00", "0.00", "0.00"],
    ]);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("terminal-loss ownership is evaluated at the requested year-end date", { skip: !DB }, async () => {
  const { org, actorId } = await seededOrg();
  try {
    const categoryId = await seedTaxCategory(org, "Class 8 equipment", { ca_cca_class: "8" });
    const assetId = await seedAsset(org, actorId, categoryId, "10000.00", "2023-05-01");
    await runYear(org, actorId, "ca_cca", 2023);

    // It was still owned at 2024 year-end; only a 2025 disposal changes the
    // current status.  A rerun of 2024 must not manufacture a terminal loss.
    await seedDisposalEvent(org, actorId, assetId, "2025-01-01", "10000.00");
    const result = await runYear(org, actorId, "ca_cca", 2024);
    assert.deepEqual(result.lines.map((line) => [line.allowance, line.terminalLoss, line.closingBalance]), [
      ["1800.00", "0.00", "7200.00"],
    ]);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a failing class persists nothing — the whole year rolls back atomically", { skip: !DB }, async () => {
  const { org, actorId } = await seededOrg();
  try {
    const cat8 = await seedTaxCategory(org, "Class 8 equipment", { ca_cca_class: "8" });
    const cat9 = await seedTaxCategory(org, "Tenant class 9", { ca_cca_class: "9" });
    await seedPoolClass(org, "9");
    const scope: RunScope = org;

    // Baseline year computes cleanly for both classes.
    await seedAsset(org, actorId, cat8, "10000.00", "2023-05-01");
    await seedAsset(org, actorId, cat9, "5000.00", "2023-06-01");
    const baseline = await runYear(scope, actorId, "ca_cca", 2023);
    assert.deepEqual(baseline.lines.map((l) => [l.classCode, l.allowance, l.closingBalance]), [
      ["8", "1000.00", "9000.00"],
      ["9", "500.00", "4500.00"],
    ]);
    const poolsAfterBaseline = await poolsFor(org.orgId);
    assert.equal(poolsAfterBaseline.length, 2);

    // Poison the NEXT year: class 8 stays fine, but class 9's additions sum to
    // 16 integer digits — beyond numeric(19,4). The failure surfaces mid-persist,
    // AFTER class 8's period and roll-forward have been staged.
    const poison1 = await seedAsset(org, actorId, cat9, "500000000000000.0000", "2024-02-01");
    const poison2 = await seedAsset(org, actorId, cat9, "500000000000000.0000", "2024-03-01");
    await assert.rejects(
      runYear(scope, actorId, "ca_cca", 2024),
      (error: unknown) => {
        const wrapped = error as { message?: string; cause?: { message?: string } };
        const text = `${wrapped.message ?? ""} ${wrapped.cause?.message ?? ""}`;
        return /numeric field overflow|out of range/i.test(text);
      },
    );

    // Nothing from the poisoned run survived: no 2024 period anywhere, every
    // pool still carries its 2023 closing as the roll-forward.
    const periods = await periodsFor(org.orgId);
    assert.equal(periods.length, 2);
    assert.ok(periods.every((p) => p.tax_year === 2023));
    const openings = new Map((await poolsFor(org.orgId)).map((p) => [p.class_code, p.opening_balance]));
    assert.equal(openings.get("8"), "9000.0000");
    assert.equal(openings.get("9"), "4500.0000");

    // Retry after removing the poison commits ONE complete year: both classes'
    // periods chained from the untouched 2023 closings, plus their roll-forwards.
    await db.execute(sql`delete from fixed_assets where id in (${poison1}, ${poison2})`);
    const retry = await runYear(scope, actorId, "ca_cca", 2024);
    assert.equal(retry.taxYear, 2024);
    assert.deepEqual(retry.lines.map((l) => [l.classCode, l.allowance, l.closingBalance]), [
      ["8", "1800.00", "7200.00"], // 9000 × 20%, nothing new placed in service
      ["9", "450.00", "4050.00"], // 4500 × 10%
    ]);
    const afterRetry = await periodsFor(org.orgId);
    assert.equal(afterRetry.length, 4, "two classes × two complete years");
    const byClass = new Map(
      (await db.execute<{ class_code: string; opening_balance: string; closing_balance: string; tax_year: number }>(sql`
        select tp.class_code, pp.opening_balance::text, pp.closing_balance::text, pp.tax_year
          from tax_pool_periods pp
          join tax_depreciation_pools tp on tp.id = pp.pool_id and tp.org_id = pp.org_id
         where pp.org_id = ${org.orgId} and pp.tax_year = 2024`)).rows.map((r) => [r.class_code, r]),
    );
    assert.equal(byClass.get("8")!.opening_balance, "9000.0000", "retry opens from the pre-failure close");
    assert.equal(byClass.get("9")!.opening_balance, "4500.0000");
    const rolledForward = new Map((await poolsFor(org.orgId)).map((p) => [p.class_code, p.opening_balance]));
    assert.equal(rolledForward.get("8"), byClass.get("8")!.closing_balance);
    assert.equal(rolledForward.get("9"), byClass.get("9")!.closing_balance);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("concurrent runs of the same year serialize and land identical idempotent results", { skip: !DB }, async () => {
  const { org, actorId } = await seededOrg();
  try {
    const cat8 = await seedTaxCategory(org, "Class 8 equipment", { ca_cca_class: "8" });
    await seedAsset(org, actorId, cat8, "10000.00", "2023-05-01");
    const scope: RunScope = org;

    const [first, second] = await Promise.all([
      runYear(scope, actorId, "ca_cca", 2023),
      runYear(scope, actorId, "ca_cca", 2023),
    ]);
    assert.deepEqual(first, second);

    const rows = await periodsFor(org.orgId);
    assert.equal(rows.length, 1, "one period row per pool despite two concurrent runs");
    assert.equal(rows[0]!.opening_balance, "0.0000");
    assert.equal(rows[0]!.allowance, "1000.0000");
    assert.equal(rows[0]!.closing_balance, "9000.0000");
    const pools = await poolsFor(org.orgId);
    assert.equal(pools.length, 1);
    assert.equal(pools[0]!.opening_balance, rows[0]!.closing_balance, "pool carry-forward equals the committed closing");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("concurrent adjacent-year runs fence safely: chained in order, or the earlier year refused", { skip: !DB }, async () => {
  const { org, actorId } = await seededOrg();
  try {
    const cat8 = await seedTaxCategory(org, "Class 8 equipment", { ca_cca_class: "8" });
    await seedAsset(org, actorId, cat8, "10000.00", "2023-05-01");
    const scope: RunScope = org;

    const settled = await Promise.allSettled([
      runYear(scope, actorId, "ca_cca", 2023),
      runYear(scope, actorId, "ca_cca", 2024),
    ]);
    const fulfilled = settled.filter((s): s is PromiseFulfilledResult<Awaited<ReturnType<typeof runYear>>> => s.status === "fulfilled");
    const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");

    if (fulfilled.length === 2) {
      // The lock ordered them ascending; the chain must be continuous.
      const byYear = new Map(fulfilled.map((f) => [f.value.taxYear, f.value]));
      assert.equal(byYear.get(2023)?.lines[0]?.closingBalance, "9000.00");
      assert.equal(byYear.get(2024)?.lines[0]?.openingBalance, "9000.00", "2024 opens exactly where 2023 closed");
      const rows = await periodsFor(org.orgId);
      assert.deepEqual(rows.map((r) => r.tax_year), [2023, 2024]);
      const [p23, p24] = rows as [PeriodRow, PeriodRow];
      assert.equal(p24.opening_balance, p23.closing_balance);
      const pools = await poolsFor(org.orgId);
      assert.equal(pools[0]!.opening_balance, p24.closing_balance);
    } else {
      // 2024 won the race: 2023 must be REFUSED, never silently mis-opened
      // from a later year's carry-forward.
      assert.equal(rejected.length, 1);
      assert.match(String(rejected[0]!.reason), /already computed|consecutively/);
      assert.ok(fulfilled.every((f) => f.value.taxYear === 2024));
      const rows = await periodsFor(org.orgId);
      assert.deepEqual(rows.map((r) => r.tax_year), [2024], "only the winning later year is on file");
      const pools = await poolsFor(org.orgId);
      assert.equal(pools[0]!.opening_balance, rows[0]!.closing_balance);
    }
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("years run consecutively: restating or skipping closed years is refused with the remedy", { skip: !DB }, async () => {
  const { org, actorId } = await seededOrg();
  try {
    const cat8 = await seedTaxCategory(org, "Class 8 equipment", { ca_cca_class: "8" });
    await seedAsset(org, actorId, cat8, "10000.00", "2023-05-01");
    const scope: RunScope = org;

    await runYear(scope, actorId, "ca_cca", 2023);

    // A restated early year would invalidate the closings that build on it…
    await assert.rejects(
      runYear(scope, actorId, "ca_cca", 2022),
      (error: unknown) => error instanceof TaxPoolError && /2022 cannot be run because tax year 2023 is already computed/.test(error.message),
    );
    // …and a skipped year would claim no allowance on the carried balance.
    await assert.rejects(
      runYear(scope, actorId, "ca_cca", 2026),
      (error: unknown) =>
        error instanceof TaxPoolError
        && /next declared year after 2023-12-31/.test(error.message)
        && /consecutively/.test(error.message),
    );
    let rows = await periodsFor(org.orgId);
    assert.deepEqual(rows.map((r) => r.tax_year), [2023], "refused runs leave the chain untouched");

    // The immediate successor chains from the prior close.
    await seedAsset(org, actorId, cat8, "4000.00", "2024-02-01");
    await runYear(scope, actorId, "ca_cca", 2024);
    rows = await periodsFor(org.orgId);
    assert.deepEqual(rows.map((r) => r.tax_year), [2023, 2024]);
    assert.equal(rows[1]!.opening_balance, rows[0]!.closing_balance);
    assert.equal(rows[1]!.additions, "4000.0000");
    assert.equal(rows[1]!.allowance, "2200.0000"); // (9000 + 4000/2) × 20%
    assert.equal(rows[1]!.closing_balance, "10800.0000"); // 13000 − 2200

    // Re-running the latest year reuses ITS ORIGINAL opening even though the
    // pool carry-forward moved on, so the recompute is faithful.
    await seedAsset(org, actorId, cat8, "6000.00", "2024-09-01");
    const rerun = await runYear(scope, actorId, "ca_cca", 2024);
    rows = await periodsFor(org.orgId);
    assert.equal(rows.length, 2, "re-running upserts rather than duplicating");
    assert.equal(rows[1]!.opening_balance, rows[0]!.closing_balance, "original opening preserved on re-run");
    assert.equal(rows[1]!.additions, "10000.0000");
    assert.equal(rows[1]!.allowance, "2800.0000"); // (9000 + 10000/2) × 20%
    assert.equal(rows[1]!.closing_balance, "16200.0000"); // 19000 − 2800
    assert.deepEqual(rerun.lines[0], {
      classCode: "8",
      className: "Furniture, equipment, machinery",
      openingBalance: "9000.00",
      additions: "10000.00",
      dispositions: "0.00",
      allowance: "2800.00",
      closingBalance: "16200.00",
      recapture: "0.00",
      terminalLoss: "0.00",
    });
    const pools = await poolsFor(org.orgId);
    assert.equal(pools[0]!.opening_balance, "16200.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a MACRS short year computes Pub 946 dates and refuses a factor that disagrees", { skip: !DB }, async () => {
  const { org, actorId } = await seededOrg();
  try {
    const cat5 = await seedTaxCategory(org, "5-year property", { us_macrs_class: "gds_5" });
    await seedAsset(org, actorId, cat5, "10000.00", "2023-03-15");
    const scope: RunScope = org;

    await declareYear(scope, actorId, "us_macrs", 2023, "2023-01-01", "2023-06-30");
    await assert.rejects(
      runTaxPool(scope.orgId, scope.bookId, scope.subsidiaryId, "us_macrs", 2023, {
        yearStart: "2023-01-01",
        yearEnd: "2023-06-30",
        shortYearFactor: "1",
        actorId,
      }),
      (error: unknown) => error instanceof TaxPoolError && /does not match/.test(error.message),
    );
    assert.equal((await periodsFor(org.orgId)).length, 0, "factor/date disagreement persists nothing");
    assert.equal((await poolsFor(org.orgId)).length, 0, "factor/date disagreement creates no pool");

    const short = await runTaxPool(scope.orgId, scope.bookId, scope.subsidiaryId, "us_macrs", 2023, {
      yearStart: "2023-01-01",
      yearEnd: "2023-06-30",
      shortYearFactor: "0.5",
      actorId,
    });
    // Half-year deemed April 1 in a January–June year: 3/12 × 40% × $10,000.
    assert.equal(short.lines[0]!.allowance, "1000.00");
    assert.equal((await periodsFor(org.orgId)).length, 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("the MACRS model runs under the same fence: atomic years, chaining, ordering refusals", { skip: !DB }, async () => {
  const { org, actorId } = await seededOrg();
  try {
    const cat5 = await seedTaxCategory(org, "5-year property", { us_macrs_class: "gds_5" });
    await seedAsset(org, actorId, cat5, "10000.00", "2023-03-15");
    const scope: RunScope = org;

    const y1 = await runYear(scope, actorId, "us_macrs", 2023);
    assert.equal(y1.lines[0]!.classCode, "gds_5");
    assert.equal(y1.lines[0]!.allowance, "2000.00"); // half-year 200% DB on 5-year
    assert.equal(y1.lines[0]!.closingBalance, "8000.00");

    const y2 = await runYear(scope, actorId, "us_macrs", 2024);
    assert.equal(y2.lines[0]!.openingBalance, "8000.00", "year two opens from the schedule's remaining basis");
    assert.equal(y2.lines[0]!.allowance, "3200.00");
    assert.equal(y2.lines[0]!.closingBalance, "4800.00");

    await assert.rejects(
      runYear(scope, actorId, "us_macrs", 2022),
      (error: unknown) => error instanceof TaxPoolError && /2022 cannot be run because tax year 2024 is already computed/.test(error.message),
    );

    const rows = await periodsFor(org.orgId);
    assert.deepEqual(rows.map((r) => r.tax_year), [2023, 2024]);
    assert.equal(rows[1]!.opening_balance, rows[0]!.closing_balance);
    const pools = await poolsFor(org.orgId);
    assert.equal(pools[0]!.opening_balance, rows[1]!.closing_balance);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a MACRS asset placed and taxably disposed in the same tax year takes no deduction", { skip: !DB }, async () => {
  const { org, actorId } = await seededOrg();
  try {
    const cat5 = await seedTaxCategory(org, "5-year property", { us_macrs_class: "gds_5" });
    const assetId = await seedAsset(org, actorId, cat5, "10000.00", "2023-03-15");
    await seedDisposalEvent(org, actorId, assetId, "2023-09-01", "4000.00");
    const result = await runYear(org, actorId, "us_macrs", 2023);
    assert.equal(result.lines[0]!.allowance, "0.00");
    assert.equal(result.lines[0]!.closingBalance, "0.00");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a MACRS placement after the tax-year window is not given a deemed first-year date", { skip: !DB }, async () => {
  const { org, actorId } = await seededOrg();
  try {
    const cat5 = await seedTaxCategory(org, "5-year property", { us_macrs_class: "gds_5" });
    await seedAsset(org, actorId, cat5, "10000.00", "2023-10-01");
    await declareYear(org, actorId, "us_macrs", 2023, "2023-01-01", "2023-06-30");
    const result = await runTaxPool(org.orgId, org.bookId, org.subsidiaryId, "us_macrs", 2023, {
      yearStart: "2023-01-01",
      yearEnd: "2023-06-30",
      shortYearFactor: "0.5",
      actorId,
    });
    assert.equal(result.lines.length, 0);
    assert.equal((await periodsFor(org.orgId)).length, 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a 0.49 short-year factor refuses instead of rounding into a six-month year", { skip: !DB }, async () => {
  const { org, actorId } = await seededOrg();
  try {
    const cat5 = await seedTaxCategory(org, "5-year property", { us_macrs_class: "gds_5" });
    await seedAsset(org, actorId, cat5, "10000.00", "2023-03-15");
    await declareYear(org, actorId, "us_macrs", 2023, "2023-01-01", "2023-06-30");
    await assert.rejects(
      runTaxPool(org.orgId, org.bookId, org.subsidiaryId, "us_macrs", 2023, {
        yearStart: "2023-01-01",
        yearEnd: "2023-06-30",
        shortYearFactor: "0.49",
        actorId,
      }),
      (error: unknown) => error instanceof TaxPoolError && /does not match/.test(error.message),
    );
    assert.equal((await periodsFor(org.orgId)).length, 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

async function approveChange(org: ScratchOrg, actors: FlowActors, id: string) {
  await submitFinancialChange(org.orgId, id, actors.submitterId);
  const gate = (
    await db.execute<{ id: string }>(sql`
      select id from flow_gates where org_id=${org.orgId}
       and subject_id=${id} and status='pending'`)
  ).rows[0];
  assert.ok(gate, "the native submission must create an approval gate");
  await decideGate({
    gateId: gate.id,
    userId: actors.approver1Id,
    decision: "approved",
  });
}

test("runTaxPool persists carryover+excess matching and freezes the cited window", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    await withOrgContext(org.orgId, async () => {
      const actors = await seedFlowActors(org.orgId);
      await db.execute(sql`
        insert into user_permission_overrides(org_id,user_id,permission,effect)
        values(${org.orgId},${actors.submitterId},'assets.manage','grant')`);
      await seedApprovalFlow(org.orgId, {
        subjectKind: "financial_change",
        mode: "any",
        preventSelfApproval: false,
        assignees: [{ type: "user", userId: actors.approver1Id }],
      });
      const buyer = randomUUID();
      const elimination = randomUUID();
      const dueFrom = randomUUID();
      const dueTo = randomUUID();
      await db.execute(sql`
        insert into subsidiaries(id,org_id,parent_id,name,base_currency,country,tax_ids,is_elimination,is_active,custom)
        values(${buyer},${org.orgId},${org.subsidiaryId},'Matching buyer','CAD','CA','{}'::jsonb,false,true,'{}'::jsonb),
          (${elimination},${org.orgId},${org.subsidiaryId},'Matching elimination','CAD','CA','{}'::jsonb,true,true,'{}'::jsonb)`);
      for (const [id, number, type] of [
        [dueFrom, "1997", "asset_current_other"],
        [dueTo, "2997", "liability_current_other"],
      ]) {
        await db.execute(sql`
          insert into accounts(id,org_id,number,name,type,is_summary,is_active,eliminate,reconcilable,
            required_dimensions,custom,subsidiary_include_children)
          values(${id},${org.orgId},${number},${number},${type},false,true,true,false,'[]'::jsonb,'{}'::jsonb,true)`);
      }
      await db.execute(sql`
        insert into intercompany_pairs(org_id,from_subsidiary_id,to_subsidiary_id,due_from_account_id,due_to_account_id)
        values(${org.orgId},${org.subsidiaryId},${buyer},${dueFrom},${dueTo})`);
      const sellerCategory = randomUUID();
      const buyerCategory = randomUUID();
      const assetId = randomUUID();
      for (const [id, name, attributes] of [
        [sellerCategory, "Book-only matching seller", {}],
        [buyerCategory, "MACRS matching buyer", { us_macrs_class: "gds_5" }],
      ] as const) {
        await db.execute(sql`
          insert into asset_categories(id,org_id,name,asset_account_id,accumulated_depreciation_account_id,
            depreciation_expense_account_id,gain_loss_account_id,default_method,default_life_months,
            default_convention,tax_attributes)
          values(${id},${org.orgId},${name},${org.accounts.invAsset},${org.accounts.clearing},
            ${org.accounts.adjustment},${org.accounts.adjustment},'straight_line',60,'full_month',
            ${JSON.stringify(attributes)}::jsonb)`);
      }
      await db.execute(sql`
        insert into tax_regimes(org_id,code,name,country_code,calculation_model,class_attribute,is_active)
        values(${org.orgId},'us_macrs','United States MACRS','US','macrs','us_macrs_class',true)`);
      await db.execute(sql`
        insert into fixed_assets(id,org_id,subsidiary_id,category_id,asset_number,name,status,
          acquired_on,in_service_on,acquisition_cost,salvage_value,useful_life_months)
        values(${assetId},${org.orgId},${org.subsidiaryId},${sellerCategory},${`MATCH-${assetId}`},
          'Example 4 matching source','in_service','2023-01-01','2023-01-01',100,0,60)`);
      await buildSchedule(assetId, org.orgId, actors.submitterId, org.bookId);
      const transferId = await proposeAssetChange(org.orgId, assetId, actors.submitterId, {
        operation: "intercompany_transfer",
        effectiveOn: "2025-08-20",
        reason: "Sell the asset inside the consolidated group",
        assessment: "Example 4 taxable intercompany sale with §168(i)(7) carryover and excess",
        idempotencyKey: randomUUID(),
        portion: { percent: "100" },
        proceeds: "130",
        proceedsAccountId: dueFrom,
        transfer: {
          subsidiaryId: buyer,
          categoryId: buyerCategory,
          assetNumber: `RECV-${assetId}`,
          name: "Received Example 4 asset",
          buyerAmount: "130",
          buyerSalvage: "0",
          lifeMonths: 60,
          payableAccountId: dueTo,
          eliminationSubsidiaryId: elimination,
          sellerToGroupRate: "1",
          buyerToGroupRate: "1",
          sellerToBuyerRate: "1",
          ctaAccountId: org.accounts.fxGainLoss,
          groupAssetAccountId: org.accounts.invAsset,
          groupAccumulatedAccountId: org.accounts.clearing,
          groupDepreciationAccountId: org.accounts.adjustment,
          groupGainLossAccountId: org.accounts.recognized,
          taxRatePercent: "25",
          deferredTaxAccountId: org.accounts.deferred,
          taxExpenseAccountId: org.accounts.fxGainLoss,
          exchangeRateEvidence: "Both legal entities and group report CAD at a rate of one",
          groupAssessment: "Preserve the original book cost and eliminate the internal margin",
        },
      });
      await approveChange(org, actors, transferId);
      await applyAssetChange(org.orgId, transferId, actors.submitterId);
      for (const [subsidiaryId, years] of [
        [org.subsidiaryId, [2023, 2024, 2025]],
        [buyer, [2025]],
      ] as const) {
        for (const year of years) {
          await ensureTaxYearWindow(db, org.orgId, actors.submitterId, {
            subsidiaryId,
            regime: "us_macrs",
            yearStart: `${year}-01-01`,
            yearEnd: `${year}-12-31`,
            filingYear: year,
            reason: "Declared statutory calendar year for matching run",
          });
        }
      }
      const source = (await listTaxAssetBasisSources(org.orgId, assetId, actors.submitterId))
        .sources.find((row) => row.sourceChangeId === transferId);
      assert.ok(source, "the applied book transfer must be a tax source");
      const taxId = await proposeTaxAssetBasis(org.orgId, assetId, actors.submitterId, {
        sourceChangeId: transferId,
        reason: "Record the Example 4 consolidated matching sale",
        assessment: "Taxable §168(i)(7) carryover 80 and excess 50 with membership 130-80 opening 50",
        idempotencyKey: randomUUID(),
        regimes: [{
          regime: "us_macrs",
          relationship: "non_arms_length",
          recognition: "taxable",
          relatedPerson: true,
          section168i7Kind: "consolidated_group",
          originalUnadjustedBasis: "100.00",
          placedInServiceOn: "2023-01-01",
          recoveryPeriodYears: "5",
          method: "200_db",
          convention: "half_year",
          section179: "0",
          bonusPercent: "0",
          businessUsePercent: "100",
          priorDepreciation: "20.00",
          carryoverBasis: "80.00",
          excessBasis: "50.00",
          sellerAdjustedBasis: "80.00",
          statutoryProceeds: "130.00",
          amountRealizedRule: "amount_realized",
          buyerCost: "130.00",
          buyerPlacedInServiceOn: "2025-08-20",
          buyerRecoveryPeriodYears: "5",
          buyerMethod: "200_db",
          buyerConvention: "half_year",
          consolidatedGroupMembership: {
            groupKey: "example-4-group",
            sellerSubsidiaryId: org.subsidiaryId,
            buyerSubsidiaryId: buyer,
            effectiveOn: "2025-08-20",
            throughOn: "2026-12-31",
          },
        }],
      });
      await approveChange(org, actors, taxId);
      await applyTaxAssetBasis(org.orgId, taxId, actors.submitterId);
      const result = await runTaxPool(org.orgId, org.bookId, buyer, "us_macrs", 2025, {
        yearStart: "2025-01-01",
        yearEnd: "2025-12-31",
        actorId: actors.submitterId,
      });
      assert.ok(result.consolidatedMatching.length >= 2, "carryover and excess must both match");
      const openings = result.consolidatedMatching.map((row) => row.deferredOpening);
      const recomputed = result.consolidatedMatching.map((row) => row.recomputedDeduction);
      const openingSum = formatMoney(openings.reduce((sum, amount) => add(sum, amount), "0"), 4);
      assert.equal(openingSum, "50.0000");
      assert.ok(recomputed.includes("0.00") || recomputed.includes("0.0000"));
      assert.ok(
        !recomputed.every((amount) => amount === recomputed[0]),
        "carryover and excess must not manufacture two identical seller counterfactuals",
      );
      const window = (
        await db.execute<{ id: string }>(sql`
          select id from tax_year_windows
           where org_id=${org.orgId} and subsidiary_id=${buyer}
             and regime='us_macrs' and year_start='2025-01-01'`)
      ).rows[0];
      assert.ok(window);
      const citedDelete = await taxYearWindowDeleteProblem(db, org.orgId, window.id);
      assert.match(citedDelete ?? "", /posted consolidated matching/);
      assert.match(citedDelete ?? "", /cannot be deleted/);
      const citedWrite = await taxYearWindowWriteProblem(db, org.orgId, {
        id: window.id,
        yearEnd: "2025-11-30",
        reason: "attempted rewrite of a matching year",
      });
      assert.match(citedWrite ?? "", /posted consolidated matching/);
      assert.match(citedWrite ?? "", /dates are frozen/);
      await ensureTaxYearWindow(db, org.orgId, actors.submitterId, {
        subsidiaryId: buyer,
        regime: "us_macrs",
        yearStart: "2026-01-01",
        yearEnd: "2026-12-31",
        filingYear: 2026,
        reason: "Declared the later matching year so 2025 must be replayed",
      });
      const later = await runTaxPool(org.orgId, org.bookId, buyer, "us_macrs", 2026, {
        yearStart: "2026-01-01",
        yearEnd: "2026-12-31",
        actorId: actors.submitterId,
      });
      assert.ok(later.consolidatedMatching.length >= 2, "later-year matching must keep both receiving vintages");
      const laterOpenings = formatMoney(
        later.consolidatedMatching.reduce((sum, row) => add(sum, row.deferredOpening), "0"),
        4,
      );
      assert.notEqual(laterOpenings, "50.0000", "year two must start from posted closings, not the paper opening");
      const reversalId = await proposeTaxAssetBasisReversal(
        org.orgId,
        taxId,
        actors.submitterId,
        {
          reason: "Replace the Example 4 workpaper after the later pool year",
          idempotencyKey: randomUUID(),
        },
      );
      await approveChange(org, actors, reversalId);
      await applyTaxAssetBasisReversal(org.orgId, reversalId, actors.submitterId);
      const replacementId = await proposeTaxAssetBasis(org.orgId, assetId, actors.submitterId, {
        sourceChangeId: transferId,
        reason: "Replacement Example 4 paper after the later computed year",
        assessment: "Taxable §168(i)(7) carryover 80 and excess 50 with membership 130-80 opening 50",
        idempotencyKey: randomUUID(),
        regimes: [{
          regime: "us_macrs",
          relationship: "non_arms_length",
          recognition: "taxable",
          relatedPerson: true,
          section168i7Kind: "consolidated_group",
          originalUnadjustedBasis: "100.00",
          placedInServiceOn: "2023-01-01",
          recoveryPeriodYears: "5",
          method: "200_db",
          convention: "half_year",
          section179: "0",
          bonusPercent: "0",
          businessUsePercent: "100",
          priorDepreciation: "20.00",
          carryoverBasis: "80.00",
          excessBasis: "50.00",
          sellerAdjustedBasis: "80.00",
          statutoryProceeds: "130.00",
          amountRealizedRule: "amount_realized",
          buyerCost: "130.00",
          buyerPlacedInServiceOn: "2025-08-20",
          buyerRecoveryPeriodYears: "5",
          buyerMethod: "200_db",
          buyerConvention: "half_year",
          consolidatedGroupMembership: {
            groupKey: "example-4-group",
            sellerSubsidiaryId: org.subsidiaryId,
            buyerSubsidiaryId: buyer,
            effectiveOn: "2025-08-20",
            throughOn: "2026-12-31",
          },
        }],
      });
      await approveChange(org, actors, replacementId);
      await applyTaxAssetBasis(org.orgId, replacementId, actors.submitterId);
      await assert.rejects(
        () => proposeTaxAssetBasisReversal(
          org.orgId,
          replacementId,
          actors.submitterId,
          {
            reason: "Skip required matching replay before reversing the replacement",
            idempotencyKey: randomUUID(),
          },
        ),
        (error: unknown) =>
          error instanceof TaxAssetBasisError
          && /apply tax_matching_replay/.test(error.message)
          && /do not skip a generation/.test(error.message),
      );
      const preview = await previewTaxMatchingReplay(org.orgId, actors.submitterId, replacementId);
      assert.ok(preview.citedHistoricalPeriodIds.length >= 2, "carryover and excess 2025 rows must both be cited");
      assert.equal(preview.replacementOpening, "50.0000");
      const replayedOpening = formatMoney(
        preview.replayedPeriods
          .filter((row) => row.yearStart === "2025-01-01")
          .reduce((sum, row) => add(sum, row.deferredOpening), "0"),
        4,
      );
      assert.equal(replayedOpening, "50.0000");
      const replayId = await proposeTaxMatchingReplay(org.orgId, actors.submitterId, {
        replacementWorkpaperChangeId: replacementId,
        citedHistoricalPeriodIds: preview.citedHistoricalPeriodIds,
        reason: "Replay the cited 2025 matching years onto the replacement",
        idempotencyKey: randomUUID(),
      });
      await approveChange(org, actors, replayId);
      const appliedReplay = await applyTaxMatchingReplay(org.orgId, replayId, actors.submitterId);
      assert.equal(appliedReplay.replayedPeriodIds.length, preview.citedHistoricalPeriodIds.length);
      const persisted = (
        await db.execute<{ deferred_opening: string }>(sql`
          select deferred_opening::text
            from tax_consolidated_matching_periods
           where org_id=${org.orgId}
             and workpaper_id=${preview.replacementWorkpaperId}
             and replay_change_id=${replayId}
           order by vintage_key`)
      ).rows;
      assert.equal(persisted.length, preview.citedHistoricalPeriodIds.length);
      assert.equal(
        formatMoney(persisted.reduce((sum, row) => add(sum, row.deferred_opening), "0"), 4),
        "50.0000",
      );
      const afterReplay = await proposeTaxAssetBasisReversal(
        org.orgId,
        replacementId,
        actors.submitterId,
        {
          reason: "Reverse the replacement after its required matching replay",
          idempotencyKey: randomUUID(),
        },
      );
      assert.ok(afterReplay);
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
