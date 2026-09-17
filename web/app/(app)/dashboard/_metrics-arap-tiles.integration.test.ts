import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

// F-t07-010 (and F-t01-002) — the dashboard AR/AP tiles summed the cached
// documents.open_balance (invoices/bills only) while the /ar and /ap hubs,
// the aging report, and the GL reconstruct remaining from the open-item
// lines with live application netting and credit memos netted in. Same
// labels must read the shared openItems reader, never the cache.
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
// Fixture writes cross the maintenance boundary (withBypass); the loader
// under test runs tenant-scoped through withOrgContext — the same RLS
// posture as a production request via setRequestOrg. Both are explicit
// AsyncLocalStorage scopes, so they hold regardless of which request-org
// resolver the web import chain registered.
const { db, withBypass, withOrgContext } = await import("@openbooks/engine/src/db.ts");
const { toUnits } = await import("@openbooks/engine/src/money.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/test-fixtures.ts");
const { loadDashboardMetrics } = await import("./_metrics.ts");
const { businessToday } = await import("@openbooks/engine/src/business-date.ts");
type Authz = import("@/lib/authz.ts").Authz;
type ScratchOrg = import("@openbooks/engine/src/test-fixtures.ts").ScratchOrg;

const DB = !!process.env.OPENBOOKS_DB_URL;

function authzFor(orgId: string, userId: string): Authz {
  return {
    user: {
      id: userId, email: `${userId}@test`, name: "Tile Watcher", orgId,
      roles: [{ key: "staff", name: "staff" }],
      envKind: "sandbox", productionOrgId: orgId, isSuperAdmin: false,
      homeUserId: userId, homeOrgId: orgId,
    },
    permissions: new Set(["dashboard.read", "gl.read", "ar.read", "ap.read"]),
    allowedSubsidiaryIds: null,
  };
}

async function postedDoc(
  org: ScratchOrg,
  opts: {
    kind: "customer_invoice" | "customer_credit" | "vendor_bill";
    amount: string;
    staleOpenBalance: string;
    dueDate: string;
    applications?: string[];
  },
): Promise<{ docId: string }> {
  const doc = randomUUID();
  const entry = randomUUID();
  const lineId = randomUUID();
  const isAr = opts.kind !== "vendor_bill";
  const isCredit = opts.kind === "customer_credit";
  // Hub sign convention on the side's control account: invoice/bill lines
  // carry the side's normal sign, credit lines the opposite sign.
  const lineAmount = isCredit ? `-${opts.amount}` : isAr ? opts.amount : `-${opts.amount}`;
  const account = isAr ? org.accounts.ar : org.accounts.ap;
  const offset = isAr ? org.accounts.revenue : org.accounts.adjustment;
  const party = isAr ? org.customerId : org.vendorId;
  await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,due_date,currency,fx_rate,subtotal,tax_total,total,open_balance)
    values(${doc},${org.orgId},${opts.kind},'draft',${doc},${org.subsidiaryId},${party},${org.date},${opts.dueDate},'CAD','1',${opts.amount},0,${opts.amount},${opts.staleOpenBalance})`);
  await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,source_document_id)
    values(${entry},${org.orgId},${org.bookId},${org.subsidiaryId},${entry},${org.date},${org.periodId},'draft',${doc})`);
  await db.execute(sql`insert into journal_lines(id,org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate,party_id,due_date,is_open_item)
    values(${lineId},${org.orgId},${entry},1,${account},${org.subsidiaryId},${lineAmount},'CAD',${lineAmount},'1',${party},${opts.dueDate},true),
    (${randomUUID()},${org.orgId},${entry},2,${offset},${org.subsidiaryId},-${lineAmount}::numeric,'CAD',-${lineAmount}::numeric,'1',null,${opts.dueDate},false)`);
  await db.execute(sql`update journal_entries set status='posted',posted_at=now() where id=${entry}`);
  await db.execute(sql`update documents set status='posted',posted_entry_id=${entry},posting_period_id=${org.periodId} where id=${doc}`);
  const actor = await createScratchUser(org.orgId, `tiles ${doc.slice(0, 8)}`, "admin");
  for (const applied of opts.applications ?? []) {
    const payEntry = randomUUID();
    const payLine = randomUUID();
    const payAmount = isAr ? `-${applied}` : applied;
    await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status)
      values(${payEntry},${org.orgId},${org.bookId},${org.subsidiaryId},${payEntry},${org.date},${org.periodId},'draft')`);
    await db.execute(sql`insert into journal_lines(id,org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate,party_id,is_open_item)
      values(${payLine},${org.orgId},${payEntry},1,${account},${org.subsidiaryId},${payAmount},'CAD',${payAmount},'1',${party},true),
      (${randomUUID()},${org.orgId},${payEntry},2,${org.accounts.bank},${org.subsidiaryId},-${payAmount}::numeric,'CAD',-${payAmount}::numeric,'1',null,false)`);
    await db.execute(sql`update journal_entries set status='posted',posted_at=now() where id=${payEntry}`);
    await db.execute(sql`insert into applications(org_id,from_line_id,to_line_id,amount,source_amount,source_transaction_amount,source_transaction_currency,target_transaction_amount,target_transaction_currency,settlement_rate,settlement_rate_source,settlement_rate_reference,applied_on,created_by)
      values(${org.orgId},${payLine},${lineId},${applied},${applied},${applied},'CAD',${applied},'CAD',1,'same_currency','tiles',${org.date},${actor})`);
  }
  // Knock the cache stale with a direct UPDATE (the maintenance triggers do
  // not refire) to reproduce the observed production divergence.
  await db.execute(sql`update documents set open_balance = ${opts.staleOpenBalance} where id = ${doc}`);
  return { docId: doc };
}

test("dashboard AR/AP tiles read the shared open-item reader, not the cached balances", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    // Partially paid invoice: hub reads 600, cache stale at the full 1000.
    await withBypass(() => postedDoc(org, { kind: "customer_invoice", amount: "1000", staleOpenBalance: "1000", dueDate: "2027-12-31", applications: ["400"] }));
    // Fully applied invoice: hub excludes it (remaining 0), cache stale at 500.
    await withBypass(() => postedDoc(org, { kind: "customer_invoice", amount: "500", staleOpenBalance: "500", dueDate: "2027-12-31", applications: ["500"] }));
    // Unapplied credit memo (F-t07-010 class): nets -200 like the hub/aging.
    await withBypass(() => postedDoc(org, { kind: "customer_credit", amount: "200", staleOpenBalance: "0", dueDate: "2027-12-31" }));
    // Past-due invoice pins the overdue split.
    await withBypass(() => postedDoc(org, { kind: "customer_invoice", amount: "300", staleOpenBalance: "300", dueDate: "2020-01-01" }));
    // Partially paid bill: hub reads 500, cache stale at 700.
    await withBypass(() => postedDoc(org, { kind: "vendor_bill", amount: "700", staleOpenBalance: "700", dueDate: "2027-12-31", applications: ["200"] }));

    const actor = await withBypass(() => createScratchUser(org.orgId, "Tile Reader", "admin"));
    const metrics = await withOrgContext(org.orgId, () => loadDashboardMetrics(authzFor(org.orgId, actor as unknown as string)));
    // 600 (net of receipt) + 0 (fully applied) - 200 (credit) + 300 (overdue).
    assert.equal(toUnits(metrics.openReceivables), toUnits("700"), "AR tile nets receipts and credits instead of the stale cache");
    assert.equal(toUnits(metrics.overdueReceivables), toUnits("300"), "only the past-due invoice counts as overdue");
    assert.equal(toUnits(metrics.openPayables), toUnits("500"), "AP tile nets the partial payment instead of the stale cache");
    assert.equal(toUnits(metrics.overduePayables), toUnits("0"), "nothing is past due");
    // The tiles label the cut-off their as-of readers used, so a figure
    // that excludes future-dated documents says which day it is cut at.
    assert.equal(
      metrics.asOfDate,
      await withOrgContext(org.orgId, () => businessToday(org.orgId)),
      "the metrics carry the business day the as-of readers were cut",
    );
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});
