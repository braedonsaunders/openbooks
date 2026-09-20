import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

// Approvals worklist paging — the loader must page in SQL (limit/offset per
// union leg) instead of fetching every pending gate in the org. Seeds more
// gates than one page holds and asserts the page returns a window plus a
// total, not everything.
const stateKey = Symbol.for("openbooks.approvals-paging-test");
const state: { authz: unknown } = { authz: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.approvals-paging-test')]
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
      return { url: "mock:approvals-paging-authz", shortCircuit: true };
    }
    if (specifier === "next-intl/server") {
      return { url: "mock:approvals-paging-intl", shortCircuit: true };
    }
    if (specifier === "@/lib/money-server" && context.parentURL?.includes("/approvals/")) {
      return { url: "mock:approvals-paging-money", shortCircuit: true };
    }
    if (specifier.startsWith("@/")) {
      const webRoot = import.meta.url.slice(0, import.meta.url.indexOf("/web/") + 5);
      return nextResolve(new URL(`${specifier.slice(2)}.ts`, webRoot).href, context);
    }
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
    if (url === "mock:approvals-paging-authz") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    if (url === "mock:approvals-paging-intl") {
      return { format: "module", source: mockIntl, shortCircuit: true };
    }
    if (url === "mock:approvals-paging-money") {
      return { format: "module", source: mockMoney, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db, withBypass, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { loadApprovals } = await import("./view.ts");
type Authz = import("@/lib/authz.ts").Authz;
type ScratchOrg = import("@openbooks/engine/src/testing/fixtures.ts").ScratchOrg;

const DB = !!process.env.OPENBOOKS_DB_URL;
const GATES = 60;
const DOCS = 3;
const TOTAL = GATES + DOCS;

function authzFor(orgId: string, userId: string): Authz {
  return {
    user: {
      id: userId, email: `${userId}@test`, name: "Paging Approver", orgId,
      roles: [{ key: "approver", name: "approver" }],
      envKind: "sandbox", productionOrgId: orgId, isSuperAdmin: false,
      homeUserId: userId, homeOrgId: orgId,
    },
    permissions: new Set(["flows.approve", "ap.approve", "ar.approve"]),
    allowedSubsidiaryIds: null,
  };
}

/** A posted invoice awaiting a gateless document approval (no flow run). */
async function postedPendingDoc(org: ScratchOrg, submittedBy: string, n: number): Promise<string> {
  const doc = randomUUID();
  const entry = randomUUID();
  const number = `PAGING-${String(n).padStart(3, "0")}-${doc.slice(0, 8)}`;
  await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,due_date,currency,fx_rate,subtotal,tax_total,total,open_balance,submitted_by)
    values(${doc},${org.orgId},'customer_invoice','pending_approval',${number},${org.subsidiaryId},${org.customerId},${org.date},'2027-12-31','CAD','1','1000',0,'1000','1000',${submittedBy})`);
  await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,source_document_id)
    values(${entry},${org.orgId},${org.bookId},${org.subsidiaryId},${entry},${org.date},${org.periodId},'draft',${doc})`);
  await db.execute(sql`insert into journal_lines(id,org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate,party_id,due_date,is_open_item)
    values(${randomUUID()},${org.orgId},${entry},1,${org.accounts.ar},${org.subsidiaryId},'1000','CAD','1000','1',${org.customerId},'2027-12-31',true),
    (${randomUUID()},${org.orgId},${entry},2,${org.accounts.revenue},${org.subsidiaryId},'-1000','CAD','-1000','1',null,'2027-12-31',false)`);
  await db.execute(sql`update journal_entries set status='posted',posted_at=now() where id=${entry}`);
  await db.execute(sql`update documents set posted_entry_id=${entry},posting_period_id=${org.periodId} where id=${doc}`);
  return number;
}

async function seedPagingOrg(gateCount: number, docCount: number): Promise<{ org: ScratchOrg; approver: string }> {
  const org = await withBypass(() => createScratchOrg());
  const submitter = (await withBypass(() => createScratchUser(org.orgId, "Paging Submitter", "accountant"))) as unknown as string;
  const approver = (await withBypass(() => createScratchUser(org.orgId, "Paging Approver", "approver"))) as unknown as string;
  await withBypass(async () => {
    await db.execute(sql`update orgs set settings = jsonb_set(coalesce(settings, '{}'), '{features,flows}', 'true') where id = ${org.orgId}`);
  });
  // One flow + run, many directly-assigned pending gates with spaced
  // timestamps so page membership is deterministic (oldest first).
  const flowId = randomUUID();
  const runId = randomUUID();
  await withBypass(async () => {
    await db.execute(sql`insert into flows (id, org_id, name, subject_kind, enabled, graph)
      values (${flowId}, ${org.orgId}, 'Paging flow', 'timesheet_week', true, '{}'::jsonb)`);
    await db.execute(sql`insert into flow_runs (id, org_id, flow_id, subject_kind, subject_id, trigger, status)
      values (${runId}, ${org.orgId}, ${flowId}, 'timesheet_week', ${randomUUID()}, 'on_submit', 'waiting')`);
    for (let i = 0; i < gateCount; i++) {
      const employeeId = randomUUID();
      const weekId = randomUUID();
      await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
        values (${employeeId}, ${org.orgId}, 'employee', ${`Paging Worker ${i}`}, ${org.subsidiaryId}, true, '{}'::jsonb)`);
      await db.execute(sql`insert into timesheet_weeks (id, org_id, employee_party_id, week_start, status, created_by, updated_by)
        values (${weekId}, ${org.orgId}, ${employeeId}, '2026-07-12', 'submitted', ${submitter}, ${submitter})`);
      await db.execute(sql`insert into flow_gates
        (id, org_id, flow_id, run_id, node_id, subject_kind, subject_id, title, assignee_user_id, group_key, quorum, status, created_at)
        values (${randomUUID()}, ${org.orgId}, ${flowId}, ${runId}, ${`node-${i}`}, 'timesheet_week', ${weekId},
                ${`Paging gate ${i}`}, ${approver}, ${`g-${i}`}, 'any', 'pending', now() - make_interval(mins => ${gateCount - i}))`);
    }
    for (let n = 0; n < docCount; n++) await postedPendingDoc(org, submitter, n);
  });
  return { org, approver };
}

test("approvals mine tab pages in SQL instead of returning every gate", { skip: !DB }, async () => {
  const { org, approver } = await seedPagingOrg(GATES, DOCS);
  try {

    state.authz = authzFor(org.orgId, approver);
    const first = await withOrgContext(org.orgId, () => loadApprovals({}));
    assert.ok(first, "loader returns data");
    assert.equal(first!.total, TOTAL, "loader reports the full worklist total, not the window");
    assert.equal(first!.approvalRows.length, 25, "page one holds one page, not every gate");

    const second = await withOrgContext(org.orgId, () => loadApprovals({ page: "2" }));
    assert.ok(second, "loader returns data");
    assert.equal(second!.total, TOTAL, "total is stable across pages");
    const firstKeys = new Set(first!.approvalRows.map((r) => r.key));
    for (const row of second!.approvalRows) {
      assert.ok(!firstKeys.has(row.key), `page two repeats a page-one row (${row.key})`);
    }
    assert.equal(
      first!.approvalRows.length + second!.approvalRows.length + (await withOrgContext(org.orgId, () => loadApprovals({ page: "3" })))!.approvalRows.length,
      TOTAL,
      "pages partition the whole worklist",
    );

    const mineTab = first!.tabs.find((t) => t.key === "mine");
    assert.equal(mineTab?.count, TOTAL, "mine count bubble ties the total by construction");

    const clamped = await withOrgContext(org.orgId, () => loadApprovals({ perPage: "1000" }));
    assert.ok(
      (clamped!.approvalRows.length as number) <= 50,
      "perPage cannot exceed one bulk request",
    );
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("approvals submitted tab pages its flow runs in SQL", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const submitter = (await withBypass(() => createScratchUser(org.orgId, "Paging Author", "accountant"))) as unknown as string;
    const approver = (await withBypass(() => createScratchUser(org.orgId, "Paging Reviewer", "approver"))) as unknown as string;
    await withBypass(async () => {
      await db.execute(sql`update orgs set settings = jsonb_set(coalesce(settings, '{}'), '{features,flows}', 'true') where id = ${org.orgId}`);
      const flowId = randomUUID();
      await db.execute(sql`insert into flows (id, org_id, name, subject_kind, enabled, graph)
        values (${flowId}, ${org.orgId}, 'Bill approvals', 'vendor_bill', true, '{}'::jsonb)`);
      for (let n = 0; n < 3; n++) {
        const doc = randomUUID();
        const run = randomUUID();
        const number = `SUBMITTED-${n}-${doc.slice(0, 8)}`;
        await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,due_date,currency,fx_rate,subtotal,tax_total,total,open_balance,submitted_by,created_by)
          values(${doc},${org.orgId},'vendor_bill','pending_approval',${number},${org.subsidiaryId},${org.customerId},${org.date},'2027-12-31','CAD','1','100',0,'100','100',${submitter},${submitter})`);
        await db.execute(sql`insert into flow_runs (id, org_id, flow_id, subject_kind, subject_id, trigger, status)
          values (${run}, ${org.orgId}, ${flowId}, 'vendor_bill', ${doc}, 'on_submit', 'waiting')`);
        await db.execute(sql`insert into flow_gates
          (id, org_id, flow_id, run_id, node_id, subject_kind, subject_id, title, assignee_user_id, group_key, quorum, status)
          values (${randomUUID()}, ${org.orgId}, ${flowId}, ${run}, 'node-1', 'vendor_bill', ${doc},
                  'Manager approval', ${approver}, 'g-1', 'any', 'pending')`);
      }
    });
    state.authz = authzFor(org.orgId, submitter);
    const data = await withOrgContext(org.orgId, () => loadApprovals({ tab: "submitted" }));
    assert.ok(data, "loader returns data");
    assert.equal(data!.submittedTotal, 3, "submitted tab reports its own total");
    assert.equal(data!.submittedRows.length, 3, "single-page submitted tab returns every row");
    const empty = await withOrgContext(org.orgId, () => loadApprovals({ tab: "submitted", page: "2" }));
    assert.equal(empty!.submittedTotal, 3, "total is stable past the last page");
    assert.equal(empty!.submittedRows.length, 0, "past-the-end page is empty, not an error");
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("paged worklist agrees with the full worklist the tile counts", { skip: !DB }, async () => {
  // The center reads windowed legs while the dashboard tile reads the full
  // union: same legs, same predicates, so walking every page must reproduce
  // the full set, the total, and the kind chips exactly.
  const { approvalWorklistForAuthz, approvalWorklistPageForAuthz } = await import("@/lib/application/approvals");
  type Full = Awaited<ReturnType<typeof approvalWorklistForAuthz>>;
  const { org, approver } = await seedPagingOrg(30, 4);
  try {
    const authz = authzFor(org.orgId, approver);
    const full = await withOrgContext(org.orgId, () => approvalWorklistForAuthz(authz));
    const seen: Full = [];
    let total = -1;
    let chips = new Map<string, number>();
    for (let pageNum = 1; ; pageNum++) {
      const window = await withOrgContext(org.orgId, () =>
        approvalWorklistPageForAuthz(authz, { limit: 10, offset: (pageNum - 1) * 10 }),
      );
      if (pageNum === 1) {
        total = window.total;
        chips = window.kindCounts;
      } else {
        assert.equal(window.total, total, "total is stable across pages");
      }
      seen.push(...window.items);
      if (window.items.length < 10) break;
      assert.ok(pageNum < 10, "paging terminates");
    }
    const keyOf = (item: Full[number]): string => {
      if (item.kind === "flow_gate") return `flow_gate:${item.id}`;
      if (item.kind === "document") return `document:${item.id}`;
      if (item.kind === "budget") return `budget:${item.id}`;
      return `pay_run:${item.id}`;
    };
    assert.deepEqual(
      new Set(seen.map(keyOf)),
      new Set(full.map(keyOf)),
      "pages accumulate exactly the full set",
    );
    assert.equal(total, full.length, "paged total ties the full count");
    const expectedChips = new Map<string, number>();
    for (const item of full) {
      const kind =
        item.kind === "flow_gate"
          ? (item.document?.kind ?? item.subjectKind)
          : item.kind === "document"
            ? item.docKind
            : item.kind === "budget"
              ? "budget_scenario"
              : "pay_run";
      expectedChips.set(kind, (expectedChips.get(kind) ?? 0) + 1);
    }
    assert.deepEqual(Object.fromEntries(chips), Object.fromEntries(expectedChips), "kind chips tie the full set");
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});
