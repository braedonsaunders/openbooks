import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

// F-t01-007 — the dashboard tile counts the unified approval worklist
// (Flows gates + gateless document approvals + pay runs) while the
// approvals center mine/all tabs read gates-only queries: 97 gateless
// pending documents on a live tenant show as tile 97 vs empty tabs. The center
// must read the same union reader as the tile.
const stateKey = Symbol.for("openbooks.approvals-union-test");
const state: { authz: unknown } = { authz: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.approvals-union-test')]
  export async function getAuthz() { return state.authz }
  export async function requirePermission() { return state.authz }
  export function can(authz, permission) { return authz.permissions.has(permission) }
`;
const mockIntl = `
  export async function getTranslations() { return (key) => key }
`;
const mockMoney = `
  export async function getMoneyFormatter() { return { money: String, moneyCompact: String } }
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier === "../../../lib/authz" && context.parentURL?.includes("/approvals/")) {
      return { url: "mock:approvals-union-authz", shortCircuit: true };
    }
    if (specifier === "next-intl/server") {
      return { url: "mock:approvals-union-intl", shortCircuit: true };
    }
    if (specifier === "@/lib/money-server" && context.parentURL?.includes("/approvals/")) {
      return { url: "mock:approvals-union-money", shortCircuit: true };
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
    if (context.parentURL?.startsWith("mock:")) {
      return nextResolve(specifier, { ...context, parentURL: import.meta.url });
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:approvals-union-authz") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    if (url === "mock:approvals-union-intl") {
      return { format: "module", source: mockIntl, shortCircuit: true };
    }
    if (url === "mock:approvals-union-money") {
      return { format: "module", source: mockMoney, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db, withBypass, withOrgContext } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  "@openbooks/engine/src/test-fixtures.ts"
);
const { loadApprovals } = await import("./view.ts");
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
    permissions: new Set(["flows.approve", "ap.approve", "ar.approve"]),
    allowedSubsidiaryIds: null,
  };
}

/** A posted invoice awaiting a gateless document approval (no flow run). */
async function postedPendingDoc(org: ScratchOrg, submittedBy: string): Promise<{ docId: string; number: string }> {
  const doc = randomUUID();
  const entry = randomUUID();
  const number = `UNION-${doc.slice(0, 8)}`;
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

for (const tab of ["mine", "all"] as const) {
  test(`approvals ${tab} tab lists gateless pending documents like the tile`, { skip: !DB }, async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const submitter = await withBypass(() => createScratchUser(org.orgId, "Union Submitter", "accountant"));
      const approver = await withBypass(() => createScratchUser(org.orgId, "Union Approver", "approver"));
      const pending = await withBypass(() => postedPendingDoc(org, submitter as unknown as string));
      state.authz = authzFor(org.orgId, approver as unknown as string);
      const data = await withOrgContext(org.orgId, () =>
        loadApprovals(tab === "all" ? { tab: "all" } : {}),
      );
      assert.ok(data, "loader returns data");
      assert.equal(data!.approvalRows.length, 1, `${tab} tab reads the union reader, not gates-only`);
      assert.equal(data!.approvalRows[0]!.documentNumber, pending.number);
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  });
}
