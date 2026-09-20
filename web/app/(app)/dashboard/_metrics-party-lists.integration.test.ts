import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

// The top-customers / top-vendors lists roll the same open items the stock
// tiles read through the same groupByCustomer/groupByVendor the AR/AP
// cockpits list — largest balance first, top five. The cross-check calls
// arPosition/apPosition on the same org: a party never owes one figure on
// the dashboard and another on its hub.
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
const { db, withBypass, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { toUnits } = await import("@openbooks/engine/src/money/money.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { withSimClock: pinClock } = await import("@openbooks/engine/src/platform/clock.ts");
const { arPosition } = await import("@/lib/cash/ar-position.ts");
const { apPosition } = await import("@/lib/cash/ap-position.ts");
const { loadDashboardMetrics } = await import("./_metrics.ts");
const { canSeeWidget } = await import("./_widget-access.ts");
type Authz = import("@/lib/authz.ts").Authz;
type ScratchOrg = import("@openbooks/engine/src/testing/fixtures.ts").ScratchOrg;

const DB = !!process.env.OPENBOOKS_DB_URL;
const TODAY = "2026-07-15";

function authzFor(orgId: string, userId: string, permissions: string[]): Authz {
  return {
    user: {
      id: userId, email: `${userId}@test`, name: "Party Watcher", orgId,
      roles: [{ key: "staff", name: "staff" }],
      envKind: "sandbox", productionOrgId: orgId, isSuperAdmin: false,
      homeUserId: userId, homeOrgId: orgId,
    },
    permissions: new Set(permissions),
    allowedSubsidiaryIds: null,
  };
}

async function postedOpenItem(
  org: ScratchOrg,
  opts: { side: "ar" | "ap"; amount: string; postingDate?: string; period?: string; dueDate: string; docNo: string; party?: string },
): Promise<void> {
  const isAr = opts.side === "ar";
  const doc = randomUUID();
  const entry = randomUUID();
  const line = randomUUID();
  const control = isAr ? org.accounts.ar : org.accounts.ap;
  const offset = isAr ? org.accounts.revenue : org.accounts.adjustment;
  const party = opts.party ?? (isAr ? org.customerId : org.vendorId);
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

test("top-party lists order, split overdue, and tie the cockpits", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const big = randomUUID();
    const small = randomUUID();
    const vend = randomUUID();
    const may = randomUUID();
    await withBypass(async () => {
      await db.execute(sql`insert into parties(id,org_id,kind,display_name,is_active,custom)
        values(${big},${org.orgId},'customer','Big Co',true,'{}'::jsonb),
              (${small},${org.orgId},'customer','Small Co',true,'{}'::jsonb),
              (${vend},${org.orgId},'vendor','Main Supplier',true,'{}'::jsonb)`);
      const cal = (await db.execute<{ fiscal_calendar_id: string }>(sql`
        select fiscal_calendar_id from accounting_periods where org_id=${org.orgId} and starts_on='2026-07-01'`)).rows[0]!.fiscal_calendar_id;
      await db.execute(sql`insert into accounting_periods(id,org_id,fiscal_year,period_number,name,starts_on,ends_on,is_adjustment,fiscal_calendar_id)
        values(${may},${org.orgId},2026,5,'2026-05','2026-05-01','2026-05-31',false,${cal})`);
    });
    // Small Co owes more in total (2000 current) but Big Co carries the
    // overdue balance (1000 of 1500): ordering is by balance, the split by
    // due date — the two answers the collections call needs first.
    await withBypass(() => postedOpenItem(org, { side: "ar", amount: "1000", postingDate: "2026-05-20", period: may, dueDate: "2026-05-27", docNo: "INV-BIG-1", party: big }));
    await withBypass(() => postedOpenItem(org, { side: "ar", amount: "500", dueDate: "2026-09-13", docNo: "INV-BIG-2", party: big }));
    await withBypass(() => postedOpenItem(org, { side: "ar", amount: "2000", dueDate: "2026-09-13", docNo: "INV-SMALL-1", party: small }));
    await withBypass(() => postedOpenItem(org, { side: "ap", amount: "700", postingDate: "2026-05-20", period: may, dueDate: "2026-05-27", docNo: "BILL-V-1", party: vend }));

    const actor = await withBypass(() => createScratchUser(org.orgId, "Party Reader", "admin"));
    const authz = authzFor(org.orgId, actor as unknown as string, ["dashboard.read", "ar.read", "ap.read"]);
    assert.equal(canSeeWidget(authz, "list-top-customers"), true);
    assert.equal(canSeeWidget(authz, "list-top-vendors"), true);
    assert.equal(canSeeWidget(authzFor(org.orgId, actor as unknown as string, ["dashboard.read", "ar.read"]), "list-top-vendors"), false);
    const metrics = await pinClock(TODAY, () =>
      withOrgContext(org.orgId, () => loadDashboardMetrics(authz, ["list-top-customers", "list-top-vendors"])),
    );
    const customers = metrics.topCustomers ?? [];
    assert.equal(customers.length, 2);
    assert.equal(customers[0]?.partyName, "Small Co", "largest balance first");
    assert.equal(toUnits(customers[0]?.amount ?? "0"), toUnits("2000"));
    assert.equal(toUnits(customers[0]?.overdue ?? "1"), toUnits("0"), "nothing past due");
    assert.equal(customers[1]?.partyName, "Big Co");
    assert.equal(toUnits(customers[1]?.amount ?? "0"), toUnits("1500"));
    assert.equal(toUnits(customers[1]?.overdue ?? "0"), toUnits("1000"), "the May invoice is past due");
    assert.equal(customers[1]?.count, 2);
    const vendors = metrics.topVendors ?? [];
    assert.equal(vendors.length, 1);
    assert.equal(vendors[0]?.partyName, "Main Supplier");
    assert.equal(toUnits(vendors[0]?.amount ?? "0"), toUnits("700"));

    const settings = { weeklyCap: "0", restrictToSafe: false };
    const [ar, ap] = await pinClock(TODAY, () =>
      withOrgContext(org.orgId, () => Promise.all([
        arPosition(org.orgId, 5, settings, undefined, null),
        apPosition(org.orgId, 5, settings, undefined, null),
      ])),
    );
    const shape = (rows: Array<{ partyId: string | null; partyName: string; amount: string; count: number; overdue: string }>) =>
      rows.map((r) => [r.partyId, r.partyName, toUnits(r.amount), r.count, toUnits(r.overdue)]);
    assert.deepEqual(shape(customers), shape(ar.byCustomer.slice(0, 5)), "customers tie the AR cockpit");
    assert.deepEqual(shape(vendors), shape(ap.byVendor.slice(0, 5)), "vendors tie the AP cockpit");
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("empty books render empty lists, never zero rows", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Party Reader", "admin"));
    const authz = authzFor(org.orgId, actor as unknown as string, ["dashboard.read", "ar.read", "ap.read"]);
    const metrics = await pinClock(TODAY, () =>
      withOrgContext(org.orgId, () => loadDashboardMetrics(authz, ["list-top-customers", "list-top-vendors"])),
    );
    assert.deepEqual(metrics.topCustomers, []);
    assert.deepEqual(metrics.topVendors, []);
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});
