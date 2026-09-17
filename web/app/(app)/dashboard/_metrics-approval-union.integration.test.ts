import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

// F-t01-007 — the dashboard "Pending approvals" widget lists the top-5
// pending FLOW GATES while the tile counts the unified worklist, so the
// widget reads "—" next to a 97 tile. Both lists must read the union.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier.startsWith("@/")) {
      const webRoot = import.meta.url.slice(0, import.meta.url.indexOf("/web/") + 5);
      return nextResolve(new URL(`${specifier.slice(2)}.ts`, webRoot).href, context);
    }
    // Worktree node_modules symlinks to the main checkout's install: pin
    // bare self-imports to this checkout (same modules a real install
    // resolves) so the loader and its transitive engine imports agree.
    if (specifier.startsWith("@openbooks/engine/")) {
      const root = import.meta.url.slice(0, import.meta.url.indexOf("/web/") + 1);
      return nextResolve(
        new URL(`engine/${specifier.slice("@openbooks/engine/".length)}`, root).href,
        context,
      );
    }
    return nextResolve(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db, withBypass, withOrgContext } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  "@openbooks/engine/src/test-fixtures.ts"
);
const { loadDashboardMetrics } = await import("./_metrics.ts");
type Authz = import("@/lib/authz.ts").Authz;
type ScratchOrg = import("@openbooks/engine/src/test-fixtures.ts").ScratchOrg;

const DB = !!process.env.OPENBOOKS_DB_URL;

function authzFor(orgId: string, userId: string): Authz {
  return {
    user: {
      id: userId, email: `${userId}@test`, name: "Union Approver", orgId,
      roles: [{ key: "approver", name: "approver" }],
      envKind: "sandbox", productionOrgId: orgId, isSuperAdmin: false,
      homeUserId: userId, homeOrgId: orgId,
    },
    permissions: new Set([
      "dashboard.read", "gl.read", "ar.read", "ap.read",
      "flows.approve", "ap.approve", "ar.approve",
    ]),
    allowedSubsidiaryIds: null,
  };
}

/** A posted invoice awaiting a gateless document approval (no flow run). */
async function postedPendingDoc(org: ScratchOrg, submittedBy: string): Promise<{ docId: string; number: string }> {
  const doc = randomUUID();
  const entry = randomUUID();
  const number = `WIDGET-${doc.slice(0, 8)}`;
  await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,due_date,currency,fx_rate,subtotal,tax_total,total,open_balance,submitted_by)
    values(${doc},${org.orgId},'customer_invoice','pending_approval',${number},${org.subsidiaryId},${org.customerId},${org.date},'2027-12-31','CAD','1','1000',0,'1000','1000',${submittedBy})`);
  await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,source_document_id)
    values(${entry},${org.orgId},${org.bookId},${org.subsidiaryId},${entry},${org.date},${org.periodId},'draft',${doc})`);
  await db.execute(sql`insert into journal_lines(id,org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate,party_id,due_date,is_open_item)
    values(${randomUUID()},${org.orgId},${entry},1,${org.accounts.ar},${org.subsidiaryId},'1000','CAD','1000','1',${org.customerId},'2027-12-31',true),
    (${randomUUID()},${org.orgId},${entry},2,${org.accounts.revenue},${org.subsidiaryId},'-1000','CAD','-1000','1',null,'2027-12-31',false)`);
  await db.execute(sql`update journal_entries set status='posted',posted_at=now() where id=${entry}`);
  await db.execute(sql`update documents set posted_entry_id=${entry},posting_period_id=${org.periodId} where id=${doc}`);
  return { docId: doc, number };
}

test("dashboard approval widgets list the unified worklist, not gates-only", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const submitter = await withBypass(() => createScratchUser(org.orgId, "Widget Submitter", "accountant"));
    const approver = await withBypass(() => createScratchUser(org.orgId, "Widget Approver", "approver"));
    const pending = await withBypass(() => postedPendingDoc(org, submitter as unknown as string));
    const metrics = await withOrgContext(org.orgId, () =>
      loadDashboardMetrics(authzFor(org.orgId, approver as unknown as string)),
    );
    assert.equal(metrics.pendingApprovals, 1, "tile counts the gateless document");
    assert.equal(metrics.pendingApprovalList.length, 1, "pending list reads the union, not gates-only");
    assert.equal(metrics.myApprovalList.length, 1, "my inbox reads the union, not gates-only");
    assert.ok(
      metrics.pendingApprovalList.some((r) => r.title === pending.number),
      "union row carries the document number",
    );
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});
