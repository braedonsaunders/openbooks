import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { runTaxPool, TaxPoolError } from "./tax-pool-run.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors, type ScratchOrg } from "./test-fixtures.ts";

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

const runYear = (
  scope: RunScope,
  actorId: string,
  regime: string,
  taxYear: number,
) =>
  runTaxPool(scope.orgId, scope.bookId, scope.subsidiaryId, regime, taxYear, {
    yearStart: `${taxYear}-01-01`,
    yearEnd: `${taxYear}-12-31`,
    actorId,
  });

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
      (error: unknown) => error instanceof TaxPoolError && /before tax year 2024/.test(error.message) && /consecutively/.test(error.message),
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
