import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

// The 30-day receipts/payments tiles predict off the same open items the
// stock tiles summarise, through the same scheduleForecast + paymentStats
// the AR/AP cockpits read — the tile and the cockpit worklist agree item
// for item, and the DSO/DPO hints quote the same globalAvg the cockpits
// label. The cross-check below calls arPosition/apPosition on the same
// scratch org: same-labeled figures tie by construction, not by hope.
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
const { arPosition } = await import("@/lib/cash/ar-position.ts");
const { apPosition } = await import("@/lib/cash/ap-position.ts");
const { loadDashboardMetrics } = await import("./_metrics.ts");
const { canSeeWidget } = await import("./_widget-access.ts");
type Authz = import("@/lib/authz.ts").Authz;
type ScratchOrg = import("@openbooks/engine/src/test-fixtures.ts").ScratchOrg;

const DB = !!process.env.OPENBOOKS_DB_URL;
const TODAY = "2026-07-15";

function authzFor(orgId: string, userId: string, permissions: string[]): Authz {
  return {
    user: {
      id: userId, email: `${userId}@test`, name: "Forecast Watcher", orgId,
      roles: [{ key: "staff", name: "staff" }],
      envKind: "sandbox", productionOrgId: orgId, isSuperAdmin: false,
      homeUserId: userId, homeOrgId: orgId,
    },
    permissions: new Set(permissions),
    allowedSubsidiaryIds: null,
  };
}

/** Posted invoice/bill with one open control line — what openItems reads. */
async function postedOpenItem(
  org: ScratchOrg,
  opts: { side: "ar" | "ap"; amount: string; postingDate?: string; period?: string; dueDate: string; docNo: string },
): Promise<void> {
  const isAr = opts.side === "ar";
  const doc = randomUUID();
  const entry = randomUUID();
  const line = randomUUID();
  const control = isAr ? org.accounts.ar : org.accounts.ap;
  const offset = isAr ? org.accounts.revenue : org.accounts.adjustment;
  const party = isAr ? org.customerId : org.vendorId;
  // Hub sign convention: invoice/bill lines carry the side's normal sign.
  const controlAmount = isAr ? opts.amount : `-${opts.amount}`;
  await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,due_date,currency,fx_rate,subtotal,tax_total,total,open_balance)
    values(${doc},${org.orgId},${isAr ? "customer_invoice" : "vendor_bill"},'draft',${opts.docNo},${org.subsidiaryId},${party},${opts.postingDate ?? org.date},${opts.dueDate},'CAD','1',${opts.amount},0,${opts.amount},${opts.amount})`);
  await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,source_document_id)
    values(${entry},${org.orgId},${org.bookId},${org.subsidiaryId},${entry},${opts.postingDate ?? org.date},${opts.period ?? org.periodId},'draft',${doc})`);
  await db.execute(sql`insert into journal_lines(id,org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate,party_id,due_date,is_open_item)
    values(${line},${org.orgId},${entry},1,${control},${org.subsidiaryId},${controlAmount},'CAD',${controlAmount},'1',${party},${opts.dueDate},true),
    (${randomUUID()},${org.orgId},${entry},2,${offset},${org.subsidiaryId},-${controlAmount}::numeric,'CAD',-${controlAmount}::numeric,'1',null,${opts.dueDate},false)`);
  await db.execute(sql`update journal_entries set status='posted',posted_at=now() where id=${entry}`);
  await db.execute(sql`update documents set status='posted',posted_entry_id=${entry},posting_period_id=${opts.period ?? org.periodId} where id=${doc}`);
}

test("30-day forecast tiles tie the cockpit positions item for item", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const may = randomUUID();
    await withBypass(async () => {
      const cal = (await db.execute<{ fiscal_calendar_id: string }>(sql`
        select fiscal_calendar_id from accounting_periods where org_id=${org.orgId} and starts_on='2026-07-01'`)).rows[0]!.fiscal_calendar_id;
      await db.execute(sql`insert into accounting_periods(id,org_id,fiscal_year,period_number,name,starts_on,ends_on,is_adjustment,fiscal_calendar_id)
        values(${may},${org.orgId},2026,5,'2026-05','2026-05-01','2026-05-31',false,${cal})`);
    });
    // Overdue May invoice/bill: no settlement history, so the 45-day model
    // fallback predicts tran+45d, pushed a week past the as-of — in window.
    await withBypass(() => postedOpenItem(org, { side: "ar", amount: "1000", postingDate: "2026-05-20", period: may, dueDate: "2026-05-27", docNo: "INV-OLD" }));
    await withBypass(() => postedOpenItem(org, { side: "ap", amount: "700", postingDate: "2026-05-20", period: may, dueDate: "2026-05-27", docNo: "BILL-OLD" }));
    // Far-term documents predict past the +30d cut-off and must not count.
    await withBypass(() => postedOpenItem(org, { side: "ar", amount: "500", dueDate: "2026-09-13", docNo: "INV-FAR" }));
    await withBypass(() => postedOpenItem(org, { side: "ap", amount: "300", dueDate: "2026-09-13", docNo: "BILL-FAR" }));

    const actor = await withBypass(() => createScratchUser(org.orgId, "Forecast Reader", "admin"));
    const authz = authzFor(org.orgId, actor as unknown as string, ["dashboard.read", "ar.read", "ap.read"]);
    assert.equal(canSeeWidget(authz, "kpi-expected-receipts-30d"), true);
    assert.equal(canSeeWidget(authz, "kpi-bills-due-30d"), true);
    assert.equal(canSeeWidget(authzFor(org.orgId, actor as unknown as string, ["dashboard.read", "ap.read"]), "kpi-expected-receipts-30d"), false);
    const ids = ["kpi-expected-receipts-30d", "kpi-bills-due-30d", "kpi-open-receivables", "kpi-open-payables"];
    const metrics = await pinClock(TODAY, () =>
      withOrgContext(org.orgId, () => loadDashboardMetrics(authz, ids)),
    );
    assert.equal(toUnits(metrics.expectedReceipts30d ?? "0"), toUnits("1000"), "only the in-window invoice predicts");
    assert.equal(toUnits(metrics.expectedPayments30d ?? "0"), toUnits("700"), "only the in-window bill predicts");
    // No settlement history anywhere: both averages are the model fallback.
    assert.equal(metrics.receivablesDso, 45);
    assert.equal(metrics.payablesDpo, 45);

    // The tie: the cockpits' own readers on the same org and scope.
    const settings = { weeklyCap: "0", restrictToSafe: false };
    const [ar, ap] = await pinClock(TODAY, () =>
      withOrgContext(org.orgId, () => Promise.all([
        arPosition(org.orgId, 5, settings, undefined, null),
        apPosition(org.orgId, 5, settings, undefined, null),
      ])),
    );
    assert.equal(toUnits(metrics.expectedReceipts30d ?? "0"), toUnits(ar.expectedNext30), "receipts tie the AR cockpit");
    assert.equal(toUnits(metrics.expectedPayments30d ?? "0"), toUnits(ap.dueNext30), "payments tie the AP cockpit");
    assert.equal(metrics.receivablesDso, ar.dso, "DSO hint quotes the cockpit average");
    assert.equal(metrics.payablesDpo, ap.dpo, "DPO hint quotes the cockpit average");
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});
