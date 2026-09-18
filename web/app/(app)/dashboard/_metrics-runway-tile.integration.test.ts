import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

// The cash-runway tile reads cashPosition itself — the same 8-week horizon,
// AP settings and subsidiary doorway as the banking cash page — never a
// re-derivation from its primitives. The cross-check calls cashPosition on
// the same org: projected end, lowest point and runway tie by construction.
// Blocked FX rates refuse into no-data (the page answers with its banner);
// anything else throws. The tile is gated banking.read: a viewer holds
// gl.read (sees today's balance) but must never see the projection.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier.startsWith("@/")) {
      return nextResolve(new URL(`../../../${specifier.slice(2)}`, import.meta.url).href, context);
    }
    // Worktree node_modules is a symlink to the main checkout's install, so
    // bare @openbooks self-imports would resolve to MAIN-checkout code (a
    // second db pool without the test bypass). Pin them to this checkout —
    // the same modules a real install resolves — process-wide, so the
    // loader under test and its transitive engine imports agree.
    if (specifier.startsWith("@openbooks/engine/")) {
      return nextResolve(
        new URL(`../../../../engine/${specifier.slice("@openbooks/engine/".length)}`, import.meta.url).href,
        context,
      );
    }
    return nextResolve(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db, withBypass, withOrgContext } = await import("@openbooks/engine/src/db.ts");
const { toUnits } = await import("@openbooks/engine/src/money.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/test-fixtures.ts");
const { withSimClock: pinClock } = await import("@openbooks/engine/src/clock.ts");
const { MissingRatesError } = await import("@/lib/consolidation.ts");
const { cashPosition } = await import("@/lib/cash/cash-position.ts");
const { loadDashboardMetrics } = await import("./_metrics.ts");
const { canSeeWidget } = await import("./_widget-access.ts");
type Authz = import("@/lib/authz.ts").Authz;
type DashboardMoneyReaders = import("./_metrics.ts").DashboardMoneyReaders;

const DB = !!process.env.OPENBOOKS_DB_URL;
const TODAY = "2026-07-15";
const RUNWAY_IDS = ["kpi-cash-runway"] as const;

function authzFor(orgId: string, userId: string, permissions: string[]): Authz {
  return {
    user: {
      id: userId, email: `${userId}@test`, name: "Runway Watcher", orgId,
      roles: [{ key: "staff", name: "staff" }],
      envKind: "sandbox", productionOrgId: orgId, isSuperAdmin: false,
      homeUserId: userId, homeOrgId: orgId,
    },
    permissions: new Set(permissions),
    allowedSubsidiaryIds: null,
  };
}

function throwingReaders(calls: string[]): DashboardMoneyReaders {
  const unused = () => { throw new Error("unreachable in this test"); };
  return {
    bankBalances: (async () => []) as DashboardMoneyReaders["bankBalances"],
    openItems: (async () => []) as DashboardMoneyReaders["openItems"],
    paymentStats: (async () => { throw new Error("paymentStats must not run here"); }) as DashboardMoneyReaders["paymentStats"],
    profitAndLoss: (async () => { throw new Error("profitAndLoss must not run here"); }) as DashboardMoneyReaders["profitAndLoss"],
    cashPosition: (async () => {
      calls.push("cashPosition");
      return unused() as never;
    }) as DashboardMoneyReaders["cashPosition"],
    cashflowConfig: (async () => {
      calls.push("cashflowConfig");
      return { weeklyCap: "0.0000", restrictToSafe: false };
    }) as DashboardMoneyReaders["cashflowConfig"],
  };
}

test("runway tile ties the banking cash page on the same org", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const may = randomUUID();
    await withBypass(async () => {
      const cal = (await db.execute<{ fiscal_calendar_id: string }>(sql`
        select fiscal_calendar_id from accounting_periods where org_id=${org.orgId} and starts_on='2026-07-01'`)).rows[0]!.fiscal_calendar_id;
      await db.execute(sql`insert into accounting_periods(id,org_id,fiscal_year,period_number,name,starts_on,ends_on,is_adjustment,fiscal_calendar_id)
        values(${may},${org.orgId},2026,5,'2026-05','2026-05-01','2026-05-31',false,${cal})`);
    });
    // 5000 cash on hand; one overdue 700 bill pulls week two down to 4300
    // and holds it there — projected end, lowest point and a long runway.
    const entry = randomUUID();
    await withBypass(async () => {
      await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin)
        values(${entry},${org.orgId},${org.bookId},${org.subsidiaryId},${entry},${org.date},${org.periodId},'draft','manual')`);
      await db.execute(sql`insert into journal_lines(id,org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate)
        values(${randomUUID()},${org.orgId},${entry},1,${org.accounts.bank},${org.subsidiaryId},'5000','CAD','5000','1'),
              (${randomUUID()},${org.orgId},${entry},2,${org.accounts.adjustment},${org.subsidiaryId},'-5000','CAD','-5000','1')`);
      await db.execute(sql`update journal_entries set status='posted',posted_at=now() where id=${entry}`);
    });
    const doc = randomUUID();
    const billEntry = randomUUID();
    const billLine = randomUUID();
    await withBypass(async () => {
      await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,due_date,currency,fx_rate,subtotal,tax_total,total,open_balance)
        values(${doc},${org.orgId},'vendor_bill','draft','BILL-OLD',${org.subsidiaryId},${org.vendorId},'2026-05-20','2026-05-27','CAD','1','700',0,'700','700')`);
      await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,source_document_id)
        values(${billEntry},${org.orgId},${org.bookId},${org.subsidiaryId},${billEntry},'2026-05-20',${may},'draft',${doc})`);
      await db.execute(sql`insert into journal_lines(id,org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate,party_id,due_date,is_open_item)
        values(${billLine},${org.orgId},${billEntry},1,${org.accounts.ap},${org.subsidiaryId},'-700','CAD','-700','1',${org.vendorId},'2026-05-27',true),
              (${randomUUID()},${org.orgId},${billEntry},2,${org.accounts.adjustment},${org.subsidiaryId},'700','CAD','700','1',null,'2026-05-27',false)`);
      await db.execute(sql`update journal_entries set status='posted',posted_at=now() where id=${billEntry}`);
      await db.execute(sql`update documents set status='posted',posted_entry_id=${billEntry},posting_period_id=${may} where id=${doc}`);
    });

    const actor = await withBypass(() => createScratchUser(org.orgId, "Runway Reader", "admin"));
    const authz = authzFor(org.orgId, actor as unknown as string, ["dashboard.read", "banking.read"]);
    assert.equal(canSeeWidget(authz, "kpi-cash-runway"), true);
    // gl.read alone sees today's balance but never the projection.
    assert.equal(canSeeWidget(authzFor(org.orgId, actor as unknown as string, ["dashboard.read", "gl.read"]), "kpi-cash-runway"), false);
    const metrics = await pinClock(TODAY, () =>
      withOrgContext(org.orgId, () => loadDashboardMetrics(authz, [...RUNWAY_IDS])),
    );
    assert.equal(toUnits(metrics.projectedCash ?? "0"), toUnits("4300"), "5000 cash minus the 700 bill");
    assert.equal(toUnits(metrics.lowestCash ?? "0"), toUnits("4300"));
    assert.equal(metrics.runwayStatus, "healthy");

    const position = await pinClock(TODAY, () =>
      withOrgContext(org.orgId, () =>
        cashPosition(org.orgId, 8, { weeklyCap: "0.0000", restrictToSafe: false }, undefined, undefined, null),
      ),
    );
    assert.equal(metrics.runwayWeeks, position.runwayWeeks, "runway ties the banking page");
    assert.equal(metrics.runwayStatus, position.runwayStatus);
    assert.equal(toUnits(metrics.projectedCash ?? "0"), toUnits(position.projectedEnd));
    assert.equal(toUnits(metrics.lowestCash ?? "0"), toUnits(position.lowestCash));
    assert.equal(metrics.lowestCashWeek, position.lowestWeek);
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("blocked FX rates refuse into nulls; anything else still throws", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Runway Reader", "admin"));
    const authz = authzFor(org.orgId, actor as unknown as string, ["dashboard.read", "banking.read"]);
    const refusing: DashboardMoneyReaders = {
      ...throwingReaders([]),
      cashPosition: (async () => { throw new MissingRatesError("rates blocked"); }) as DashboardMoneyReaders["cashPosition"],
    };
    const nulled = await pinClock(TODAY, () =>
      withOrgContext(org.orgId, () => loadDashboardMetrics(authz, [...RUNWAY_IDS], refusing)),
    );
    assert.equal(nulled.projectedCash, null);
    assert.equal(nulled.runwayWeeks, null);
    assert.equal(nulled.runwayStatus, null);
    assert.equal(nulled.lowestCash, null);
    assert.equal(nulled.lowestCashWeek, null);

    const exploding: DashboardMoneyReaders = {
      ...throwingReaders([]),
      cashPosition: (async () => { throw new Error("ledger is on fire"); }) as DashboardMoneyReaders["cashPosition"],
    };
    await assert.rejects(
      pinClock(TODAY, () => withOrgContext(org.orgId, () => loadDashboardMetrics(authz, [...RUNWAY_IDS], exploding))),
      /ledger is on fire/,
      "an unexpected position failure must not masquerade as no-data",
    );
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("runway readers never run without banking.read", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const deniedId = await withBypass(() => createScratchUser(org.orgId, "No Banking", "staff"));
    const denied = authzFor(org.orgId, deniedId as unknown as string, ["dashboard.read", "gl.read", "ar.read", "ap.read", "reports.read"]);
    assert.equal(canSeeWidget(denied, "kpi-cash-runway"), false);
    const calls: string[] = [];
    const readers = throwingReaders(calls);
    const metrics = await pinClock(TODAY, () =>
      withOrgContext(org.orgId, () => loadDashboardMetrics(denied, [], readers)),
    );
    assert.deepEqual(calls, [], "neither the config nor the position reader ran");
    assert.equal(metrics.projectedCash, null);
    assert.equal(metrics.runwayWeeks, null);
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});
