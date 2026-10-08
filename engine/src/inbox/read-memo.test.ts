import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, it } from "node:test";

// Boundary suite over the real registered adapters: one inbox read derives
// each shared actor fact (feature switch per key, the actor's party, the
// actor's pending gates) exactly once, a second read derives them again,
// the act path never reads a remembered fact, and source-table presence is
// remembered only once a table exists. Services and the database are
// replaced; the registry, guards and adapters are the real modules.

const stateKey = Symbol.for("openbooks.inbox-read-memo-test");

interface MemoState {
  features: Record<string, boolean>;
  installed: Set<string>;
  partyId: string | null;
  gates: unknown[];
  gatesFail: boolean;
  calls: Record<string, number>;
  facts: unknown[];
  queries: { sql: string; params: unknown[] }[];
}

const state: MemoState = {
  features: {},
  installed: new Set(),
  partyId: null,
  gates: [],
  gatesFail: false,
  calls: {},
  facts: [],
  queries: [],
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;
(globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for("openbooks.inbox-read-memo-dialect")] = new PgDialect();

const STATE = `const state = globalThis[Symbol.for('openbooks.inbox-read-memo-test')];
const hit = (name) => { state.calls[name] = (state.calls[name] ?? 0) + 1 };`;

const mockSources = new Map<string, string>([
  ["platform/db.ts", `${STATE}
    export const db = {
      async execute(query) {
        const compiled = globalThis[Symbol.for('openbooks.inbox-read-memo-dialect')].sqlToQuery(query);
        state.queries.push(compiled);
        const text = compiled.sql;
        if (text.includes('to_regclass')) {
          const table = compiled.params.find((param) => typeof param === 'string' && param.startsWith('public.'));
          hit('to_regclass');
          return { rows: [{ exists: state.installed.has(String(table).slice('public.'.length)) }] };
        }
        hit('sql');
        return { rows: [] };
      },
    };`],
  ["organization/org-feature-lock.ts", `${STATE}
    export async function lockAndCheckOrgFeature(_runner, orgId, key) {
      hit('feature:' + key);
      state.facts.push(['feature', orgId, key]);
      return state.features[key] === true;
    }`],
  ["hrm/authorization.ts", `${STATE}
    export class HrmAuthorizationError extends Error {}
    export async function loadApprovalPerson(_exec, orgId, userId) {
      hit('loadApprovalPerson');
      state.facts.push(['party', orgId, userId]);
      return { userId, partyId: state.partyId };
    }`],
  ["flows/gates.ts", `${STATE}
    export async function worklistGates(orgId, actorId, roles, entities) {
      hit('worklistGates');
      state.facts.push(['gates', orgId, actorId, roles, entities ? [...entities] : null]);
      if (state.gatesFail) throw new Error('gate read failed');
      return state.gates;
    }
    export async function decideGate() { hit('decideGate') }
    export async function delegateGate() { hit('delegateGate') }`],
  ["flows/approval-worklist.ts", `${STATE}
    export async function worklistApprovals() { hit('worklistApprovals'); return [] }
    export async function worklistApprovalsPage() { hit('worklistApprovalsPage'); return { items: [], total: 0, kindCounts: new Map() } }
    export async function decideDocumentApproval() { throw new Error('not under test') }`],
  ["flows/timesheet-weeks-adapter.ts", `export const TIMESHEET_WEEK_SUBJECT_KIND = 'timesheet_week';`],
  ["flows/crew-batches-adapter.ts", `export const CREW_TIME_BATCH_SUBJECT_KIND = 'crew_time_batch';`],
  ["hrm/employment-read.ts", `${STATE}
    export const HRM_FEATURE_KEY = 'hrm';
    export async function findEmploymentsByParty() { hit('findEmploymentsByParty'); return ['employment-1'] }`],
  ["hrm/field-time/settings.ts", `export const FIELD_TIME_FEATURE = 'fieldTime';`],
  ["hrm/processes.ts", `export async function completeProcessStep() { throw new Error('not under test') }`],
  ["hrm/leave.ts", `export async function submitLeaveRequest() { throw new Error('not under test') }`],
  ["hrm/leave-read.ts", `${STATE}
    export async function mayReadOwnLeaveRequests() { hit('mayReadOwnLeaveRequests'); return true }
    export async function myLeaveRequests() { hit('myLeaveRequests'); return [] }`],
  ["hrm/change-requests.ts", `${STATE}
    export async function listChangeRequests() { hit('listChangeRequests'); return [] }
    export async function getChangeRequest() { throw new Error('not under test') }
    export async function submitChangeRequest() { throw new Error('not under test') }`],
  ["hrm/performance/reviews.ts", `export async function acknowledgeReview() { throw new Error('not under test') }`],
  ["hrm/performance/performance-read.ts", `${STATE}
    export async function listMyReviews() { hit('listMyReviews'); return { asReviewer: [], asSubject: [] } }`],
  ["hrm/performance/feedback.ts", `${STATE}
    export async function feedbackFeatureEnabled() { return false }
    export async function listOpenRequestsForParty() { return [] }`],
  ["hrm/ai/anomalies.ts", `export async function listFlags() { return [] }`],
  ["hrm/ai/governance.ts", `export async function overdueReviews() { return [] }`],
  ["hrm/ai/settings.ts", `export async function loadAiRailsSettings() { return { reviewMonths: 12 } }`],
  ["organization/actor-permissions.ts", `${STATE}
    export async function actorHasPermission(_exec, orgId, actorId, permission) { hit('actorHasPermission'); state.facts.push(['permission',orgId,actorId,permission]); return true }`],
  ["automations/action-reasons.ts", `export async function validateSubmitActionReason() {}`],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (typeof specifier === "string" && specifier.startsWith("../") && context.parentURL?.includes("/engine/src/inbox/")) {
      const tail = specifier.replace(/^(\.\.\/)+/, "");
      if (mockSources.has(tail)) return { url: `mock:inbox-read-memo/${tail}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("mock:inbox-read-memo/")) {
      return { format: "module", source: mockSources.get(url.slice("mock:inbox-read-memo/".length))!, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const inbox = (await import("./index.ts?inbox-read-memo-test")) as typeof import("./index.ts");
const { beginInboxRead, memoizeForRead } = await import("./read-memo.ts");
const { actorPermissionOn } = await import("./guard.ts");
hooks.deregister();

const CTX = {
  orgId: "org-1",
  actorId: "user-1",
  asOf: "2026-08-03",
  scope: { roles: ["approver"], allowedSubsidiaryIds: null },
};

/** The badge's task kinds, as the navigation count reads them. */
const BADGE_KINDS = [
  "hrm_process_step",
  "hrm_leave_request",
  "hrm_change_request",
  "hrm_review",
  "hrm_benefit_enrollment_window",
  "hrm_qualification_alert",
  "timesheet_week",
  "payroll_anomaly_block",
  "ai_capability_review",
  "field_ticket_signature",
  "document_signature",
  "notification",
] as const;

function gate(id: string, subjectKind: string) {
  return {
    id,
    subjectKind,
    title: `gate ${id}`,
    escalateAt: null,
    createdAt: "2026-08-01T00:00:00Z",
    onBehalfOf: null,
    href: null,
  };
}

beforeEach(() => {
  Object.assign(state, {
    features: { hrm: true, payroll: true, aiGovernanceLedger: true, fieldTime: true },
    installed: new Set(["hrm_worker_qualifications", "payroll_anomaly_flags", "ai_capabilities"]),
    partyId: "party-1",
    gates: [gate("g-leave", "hrm_leave_request"), gate("g-week", "timesheet_week")],
    gatesFail: false,
    calls: {},
    facts: [],
    queries: [],
  });
});

describe("inbox read memo", () => {
  it("remembers a source table only once it exists", async () => {
    // Runs first: table presence is remembered for the process.
    state.installed = new Set(["payroll_anomaly_flags", "ai_capabilities"]);
    await inbox.countInbox(CTX, { kinds: ["hrm_qualification_alert"] });
    await inbox.countInbox(CTX, { kinds: ["hrm_qualification_alert"] });
    assert.equal(state.calls.to_regclass, 2, "an absent table is probed again on every read");
    assert.equal(state.calls.loadApprovalPerson, undefined, "an absent source reads nothing further");
    state.installed.add("hrm_worker_qualifications");
    await inbox.countInbox(CTX, { kinds: ["hrm_qualification_alert"] });
    await inbox.countInbox(CTX, { kinds: ["hrm_qualification_alert"] });
    assert.equal(state.calls.to_regclass, 3, "an installed table is probed once, then remembered");
    assert.equal(state.calls.loadApprovalPerson, 2);
  });

  it("derives each shared actor fact once per badge read and counts every source", async () => {
    const notices: { kind: string; message: string }[] = [];
    const count = await inbox.countInbox(CTX, { kinds: [...BADGE_KINDS], notices });
    assert.deepEqual(notices, []);
    assert.equal(count, 2, "both gates count once, each under its own adapter");
    assert.equal(state.calls["feature:hrm"], 1);
    assert.equal(state.calls["feature:payroll"], 1);
    assert.equal(state.calls["feature:aiGovernanceLedger"], 1);
    assert.equal(state.calls.loadApprovalPerson, 1);
    assert.equal(state.calls.worklistGates, 1);
    assert.equal(state.calls.worklistApprovals, undefined, "gate adapters never read the document leg");
  });

  it("shares the memo across every registered source of one list read", async () => {
    await inbox.listInbox(CTX);
    assert.equal(state.calls["feature:hrm"], 1);
    assert.equal(state.calls["feature:fieldTime"], 1);
    assert.equal(state.calls.loadApprovalPerson, 1);
    assert.equal(state.calls.worklistGates, 1);
  });

  it("re-derives every fact on the next read, so a revoked switch takes effect at once", async () => {
    assert.equal(await inbox.countInbox(CTX, { kinds: ["hrm_leave_request"] }), 1);
    state.features.hrm = false;
    assert.equal(await inbox.countInbox(CTX, { kinds: ["hrm_leave_request"] }), 0);
    assert.equal(state.calls["feature:hrm"], 2);
  });

  it("keeps each source's own gate on the shared facts", async () => {
    state.features.hrm = false;
    state.partyId = null;
    const items = await inbox.listInbox(CTX, { kinds: [...BADGE_KINDS] });
    assert.deepEqual(items.map((item) => item.id), ["timesheet_week:gate:g-week"]);
    assert.equal(state.calls.listMyReviews, undefined, "hrm sources stop at the switch");
    assert.equal(state.calls.mayReadOwnLeaveRequests, undefined);
  });

  it("probes a person's own leave only when the actor has a party", async () => {
    state.partyId = null;
    await inbox.listInbox(CTX, { kinds: ["hrm_leave_request"] });
    assert.equal(state.calls.mayReadOwnLeaveRequests, undefined);
    assert.equal(state.calls.myLeaveRequests, undefined);
    state.partyId = "party-1";
    await inbox.listInbox(CTX, { kinds: ["hrm_leave_request"] });
    assert.equal(state.calls.mayReadOwnLeaveRequests, 1);
    assert.equal(state.calls.myLeaveRequests, 1);
  });

  it("names every source that depends on a failed shared fact instead of counting zero", async () => {
    state.gatesFail = true;
    const notices: { kind: string; message: string }[] = [];
    const count = await inbox.countInbox(CTX, { kinds: ["hrm_leave_request", "hrm_change_request", "timesheet_week"], notices });
    assert.equal(count, 0);
    assert.deepEqual(notices.map((notice) => notice.kind), ["hrm_leave_request", "hrm_change_request", "timesheet_week"]);
    assert.equal(state.calls.worklistGates, 1);
  });

  it("keys cached source rows by identity, business date and authorization scope", async () => {
    const cache = new Map<string, import("./types.ts").InboxItem[]>();
    for (const ctx of [CTX, { ...CTX, orgId: "org-2" }, { ...CTX, actorId: "user-2" },
      { ...CTX, asOf: "2026-08-04" }, { ...CTX, scope: { roles: ["reviewer"], allowedSubsidiaryIds: ["entity-1"] } }]) {
      await inbox.listInbox(ctx, { kinds: ["hrm_leave_request"], cache });
    }
    assert.equal(state.calls.worklistGates, 5);
    assert.equal(cache.size, 5);
    assert.ok(state.facts.some((fact) => JSON.stringify(fact) === JSON.stringify(["gates", "org-2", "user-1", ["approver"], null])));
    assert.ok(state.facts.some((fact) => JSON.stringify(fact) === JSON.stringify(["gates", "org-1", "user-2", ["approver"], null])));
    await inbox.listInbox(CTX, { kinds: ["hrm_leave_request"], cache, page: { limit: 1, offset: 1 } });
    assert.equal(state.calls.worklistGates, 6, "a paged request cannot reuse a different list window");
  });

  it("separates missing native scope from explicit unrestricted scope and each source kind", async () => {
    const cache = new Map<string, import("./types.ts").InboxItem[]>();
    await inbox.listInbox({ ...CTX, scope: { roles: ["approver"] } }, { kinds: ["hrm_leave_request"], cache });
    await inbox.listInbox(CTX, { kinds: ["hrm_leave_request"], cache });
    await inbox.listInbox(CTX, { kinds: ["timesheet_week"], cache });
    assert.equal(state.calls.worklistGates, 3);
    assert.equal(cache.size, 3);
    await inbox.listInbox(CTX, { kinds: ["hrm_leave_request"], cache });
    assert.equal(state.calls.worklistGates, 3, "an identical unpaged read can reuse its source rows");
  });

  it("uses the same business date for enrollment and qualification windows", async () => {
    const ctx = { ...CTX, asOf: "2026-08-04" };
    await inbox.listInbox(ctx, { kinds: ["hrm_benefit_enrollment_window", "hrm_qualification_alert"] });
    for (const table of ["from hrm_enrollment_windows", "from public.hrm_worker_qualifications"]) {
      const query = state.queries.find((query) => query.sql.includes(table));
      assert.ok(query, table);
      assert.ok(query.params.includes(ctx.asOf));
      assert.ok(!query.sql.includes("current_date"));
    }
  });

  it("resolves each permission key once per read and keeps direct calls live", async () => {
    const read = beginInboxRead(CTX);
    await Promise.all([actorPermissionOn(read, "payroll.manage"), actorPermissionOn(read, "payroll.manage"), actorPermissionOn(read, "admin.setup.manage")]);
    assert.equal(state.calls.actorHasPermission, 2);
    await actorPermissionOn(CTX, "payroll.manage");
    await actorPermissionOn(CTX, "payroll.manage");
    assert.equal(state.calls.actorHasPermission, 4);
  });

  it("snapshots role and legal-entity scope before concurrent sources read", async () => {
    const roles = ["approver"];
    const entities = ["entity-1"];
    const read = beginInboxRead({ ...CTX, scope: { roles, allowedSubsidiaryIds: entities } });
    roles.push("admin"); entities.push("entity-2");
    assert.deepEqual(read.scope?.roles, ["approver"]);
    assert.deepEqual(read.scope?.allowedSubsidiaryIds, ["entity-1"]);
    let reads = 0;
    await Promise.all([memoizeForRead(read, "fact", async () => ++reads), memoizeForRead(read, "fact", async () => ++reads)]);
    assert.equal(reads, 1);
  });

  it("resolves facts live on the act path", async () => {
    const read = beginInboxRead(CTX);
    await inbox.actOnInboxItem(read, "timesheet_week:gate:g-week", "approve");
    await inbox.actOnInboxItem(read, "timesheet_week:gate:g-week", "approve");
    assert.equal(state.calls.worklistGates, 2, "each act re-resolves the item through a live gate read");
    assert.equal(state.calls.decideGate, 2);
  });
});
