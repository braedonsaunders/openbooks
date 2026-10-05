import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

// The revenue / expenses / net-income / gross-margin tiles read one
// consolidated period-to-date call — the same statement-matrix read as
// /reports/pnl, over the org's current fiscal period to date, never a
// parallel sum and never the civil month. A multi-functional scope is
// translated at each line-period's average rate; a scope whose consolidated
// rates were never derived refuses by name on the tile (the message names
// the remedy), never as a zero that reads as a fact.
registerHooks({
  resolve(specifier, context, nextResolve) {

    // Worktree node_modules is a symlink to the main checkout's install, so
    // bare @openbooks self-imports would resolve to MAIN-checkout code (a
    // second db pool without the test bypass). Pin them to this checkout —
    // the same modules a real install resolves — process-wide, so the
    // loader under test and its transitive engine imports agree.
    if (specifier.startsWith("@openbooks/engine/src/")) {
      return nextResolve(
        new URL(`../../../../engine/${specifier.slice("@openbooks/engine/".length)}`, import.meta.url).href,
        context,
      );
    }
    return nextResolve(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db, withBypass, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { toUnits } = await import("@openbooks/engine/src/money/money.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { withSimClock: pinClock } = await import("@openbooks/engine/src/platform/clock.ts");
const { dashboardConsolidatedProfitAndLoss } = await import("./_metrics.ts");
const { loadDashboardMetrics } = await import("./_metrics.ts");
const { canSeeWidget } = await import("./_widget-access.ts");
type Authz = import("@/lib/authz.ts").Authz;
type ScratchOrg = import("@openbooks/engine/src/testing/fixtures.ts").ScratchOrg;
type DashboardMoneyReaders = import("./_metrics.ts").DashboardMoneyReaders;

const DB = !!process.env.OPENBOOKS_DB_URL;
// The scratch fixture's open period; the loader reads the fiscal period to
// date off the pinned business day, so the clock and the postings share it.
const TODAY = "2026-07-15";

function authzFor(orgId: string, userId: string, permissions: string[]): Authz {
  return {
    user: {
      id: userId, email: `${userId}@test`, name: "P&L Watcher", orgId,
      roles: [{ key: "staff", name: "staff" }],
      envKind: "sandbox", productionOrgId: orgId, isSuperAdmin: false,
      homeUserId: userId, homeOrgId: orgId,
    },
    permissions: new Set(permissions),
    allowedSubsidiaryIds: null,
  };
}

const PNL_IDS = ["kpi-revenue-mtd", "kpi-net-income-mtd", "kpi-gross-margin-mtd"] as const;

/** Post a balanced manual entry; legs are [accountId, amount] (credit-negative). */
async function post(
  org: ScratchOrg,
  opts: { date?: string; period?: string; sub?: string; currency?: string; legs: Array<[string, string]> },
): Promise<void> {
  const entry = randomUUID();
  const currency = opts.currency ?? "CAD";
  await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin)
    values(${entry},${org.orgId},${org.bookId},${opts.sub ?? org.subsidiaryId},${entry},${opts.date ?? org.date},${opts.period ?? org.periodId},'draft','manual')`);
  for (const [index, [account, amount]] of opts.legs.entries()) {
    await db.execute(sql`insert into journal_lines(id,org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate)
      values(${randomUUID()},${org.orgId},${entry},${index + 1},${account},${opts.sub ?? org.subsidiaryId},${amount},${currency},${amount},'1')`);
  }
  await db.execute(sql`update journal_entries set status='posted',posted_at=now() where id=${entry}`);
}

function denialProofReaders(calls: string[]): DashboardMoneyReaders {
  return {
    bankBalances: (async () => []) as DashboardMoneyReaders["bankBalances"],
    openItems: (async () => []) as DashboardMoneyReaders["openItems"],
    paymentStats: (async () => {
      throw new Error("paymentStats must not run here");
    }) as DashboardMoneyReaders["paymentStats"],
    cashPosition: (async () => {
      throw new Error("cashPosition must not run here");
    }) as DashboardMoneyReaders["cashPosition"],
    cashflowConfig: (async () => {
      throw new Error("cashflowConfig must not run here");
    }) as DashboardMoneyReaders["cashflowConfig"],
    profitAndLoss: (async (...args: Parameters<DashboardMoneyReaders["profitAndLoss"]>) => {
      calls.push("profitAndLoss");
      return dashboardConsolidatedProfitAndLoss(...args);
    }) as DashboardMoneyReaders["profitAndLoss"],
  };
}

test("P&L tiles read one consolidated period-to-date call and exclude out-of-window postings", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const cogs = randomUUID();
    const june = randomUUID();
    await withBypass(async () => {
      // The scratch COGS account is typed expense; gross profit needs a true
      // cogs leg, like production charts carry.
      await db.execute(sql`insert into accounts(id,org_id,number,name,type,subsidiary_id,is_summary,is_active)
        values(${cogs},${org.orgId},'5010','Merchandise COGS','cogs',${org.subsidiaryId},false,true)`);
      const cal = (await db.execute<{ fiscal_calendar_id: string }>(sql`
        select fiscal_calendar_id from accounting_periods where org_id=${org.orgId} and starts_on='2026-07-01'`)).rows[0]!.fiscal_calendar_id;
      await db.execute(sql`insert into accounting_periods(id,org_id,fiscal_year,period_number,name,starts_on,ends_on,is_adjustment,fiscal_calendar_id)
        values(${june},${org.orgId},2026,6,'2026-06','2026-06-01','2026-06-30',false,${cal})`);
    });
    // July (in window): revenue 1000, COGS 400, expense 100.
    await withBypass(() => post(org, { legs: [[org.accounts.bank, "1000"], [org.accounts.revenue, "-1000"]] }));
    await withBypass(() => post(org, { legs: [[cogs, "400"], [org.accounts.bank, "-400"]] }));
    await withBypass(() => post(org, { legs: [[org.accounts.adjustment, "100"], [org.accounts.bank, "-100"]] }));
    // June (out of window): must not move any tile.
    await withBypass(() => post(org, { date: "2026-06-20", period: june, legs: [[org.accounts.bank, "200"], [org.accounts.revenue, "-200"]] }));

    const calls: string[] = [];
    const actor = await withBypass(() => createScratchUser(org.orgId, "P&L Reader", "admin"));
    const authz = authzFor(org.orgId, actor as unknown as string, ["dashboard.read", "reports.read"]);
    for (const id of PNL_IDS) assert.equal(canSeeWidget(authz, id), true);
    const metrics = await pinClock(TODAY, () =>
      withOrgContext(org.orgId, () => loadDashboardMetrics(authz, [...PNL_IDS], denialProofReaders(calls))),
    );
    assert.deepEqual(calls, ["profitAndLoss"], "revenue, income and margin share a single P&L read");
    assert.equal(toUnits(metrics.revenueMtd ?? "0"), toUnits("1000"), "period revenue, June excluded");
    assert.equal(toUnits(metrics.grossProfitMtd ?? "0"), toUnits("600"), "revenue minus COGS only");
    assert.equal(Number(metrics.grossMarginMtd), 0.6, "margin ratio on the 0-1 scale");
    assert.equal(toUnits(metrics.netIncomeMtd ?? "0"), toUnits("500"), "gross profit minus expenses");
    assert.equal(metrics.plCurrency, "CAD", "the tile labels the reader's currency");
    assert.ok(metrics.plPeriodLabel?.endsWith("to date"), `the tile labels the resolved period, not the civil month: ${metrics.plPeriodLabel}`);
    assert.equal(metrics.plUnavailable, null);
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("a multi-functional scope without derived rates refuses by name, never zeros", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const usSub = randomUUID();
    await withBypass(async () => {
      await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
        values(${usSub},${org.orgId},${org.subsidiaryId},'US Co','USD','US')`);
      // CAD revenue on the root subsidiary plus USD revenue inside the
      // window: the scope spans functional currencies and no consolidated
      // rates were derived, so the read refuses.
      await post(org, { legs: [[org.accounts.bank, "1000"], [org.accounts.revenue, "-1000"]] });
      await post(org, { sub: usSub, currency: "USD", legs: [[org.accounts.bank, "100"], [org.accounts.revenue, "-100"]] });
    });
    const calls: string[] = [];
    const actor = await withBypass(() => createScratchUser(org.orgId, "P&L Reader", "admin"));
    const authz = authzFor(org.orgId, actor as unknown as string, ["dashboard.read", "reports.read"]);
    const metrics = await pinClock(TODAY, () =>
      withOrgContext(org.orgId, () => loadDashboardMetrics(authz, [...PNL_IDS], denialProofReaders(calls))),
    );
    // The reader ran (denial is not the story here) and refused; the loader
    // caught the declared refusal into nulls plus the message, so the tiles
    // render the remedy instead of "—".
    assert.deepEqual(calls, ["profitAndLoss"]);
    assert.equal(metrics.revenueMtd, null);
    assert.equal(metrics.netIncomeMtd, null);
    assert.equal(metrics.grossProfitMtd, null);
    assert.equal(metrics.grossMarginMtd, null);
    assert.ok(metrics.plPeriodLabel?.endsWith("to date"), "the refusal still names the window it covers");
    assert.ok(
      metrics.plUnavailable?.includes("Derive rates"),
      `the refusal names the remedy: ${metrics.plUnavailable}`,
    );
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("derived consolidated rates translate a multi-functional scope into figures", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const usSub = randomUUID();
    await withBypass(async () => {
      await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
        values(${usSub},${org.orgId},${org.subsidiaryId},'US Co','USD','US')`);
      await db.execute(sql`insert into consolidated_fx_rates(org_id,period_id,from_currency,to_currency,current_rate,average_rate,historical_rate)
        values(${org.orgId},${org.periodId},'USD','CAD',1.35,1.35,1.3)`);
      // CAD 1000 plus USD 100 at the derived July average: translated, not refused.
      await post(org, { legs: [[org.accounts.bank, "1000"], [org.accounts.revenue, "-1000"]] });
      await post(org, { sub: usSub, currency: "USD", legs: [[org.accounts.bank, "100"], [org.accounts.revenue, "-100"]] });
    });
    const calls: string[] = [];
    const actor = await withBypass(() => createScratchUser(org.orgId, "P&L Reader", "admin"));
    const authz = authzFor(org.orgId, actor as unknown as string, ["dashboard.read", "reports.read"]);
    const metrics = await pinClock(TODAY, () =>
      withOrgContext(org.orgId, () => loadDashboardMetrics(authz, [...PNL_IDS], denialProofReaders(calls))),
    );
    assert.deepEqual(calls, ["profitAndLoss"]);
    assert.equal(toUnits(metrics.revenueMtd ?? "0"), toUnits("1135"), "USD 100 at 1.35 joins CAD 1000");
    assert.equal(metrics.plCurrency, "CAD");
    assert.equal(metrics.plUnavailable, null);
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("P&L readers never run without reports.read", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const deniedId = await withBypass(() => createScratchUser(org.orgId, "No Reports", "staff"));
    const denied = authzFor(org.orgId, deniedId as unknown as string, ["dashboard.read", "gl.read"]);
    for (const id of PNL_IDS) assert.equal(canSeeWidget(denied, id), false);
    const readers: DashboardMoneyReaders = {
      bankBalances: (async () => []) as DashboardMoneyReaders["bankBalances"],
      openItems: (async () => []) as DashboardMoneyReaders["openItems"],
      paymentStats: (async () => {
        throw new Error("paymentStats must not run here");
      }) as DashboardMoneyReaders["paymentStats"],
      cashPosition: (async () => {
        throw new Error("cashPosition must not run here");
      }) as DashboardMoneyReaders["cashPosition"],
      cashflowConfig: (async () => {
        throw new Error("cashflowConfig must not run here");
      }) as DashboardMoneyReaders["cashflowConfig"],
      profitAndLoss: (async () => {
        throw new Error("profitAndLoss must not run for a denied widget");
      }) as DashboardMoneyReaders["profitAndLoss"],
    };
    const metrics = await pinClock(TODAY, () =>
      withOrgContext(org.orgId, () => loadDashboardMetrics(denied, [], readers)),
    );
    assert.equal(metrics.revenueMtd, null);
    assert.equal(metrics.netIncomeMtd, null);
    assert.equal(metrics.grossProfitMtd, null);
    assert.equal(metrics.grossMarginMtd, null);
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});
