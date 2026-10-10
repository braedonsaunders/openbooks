import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import type { Authz } from "./authz";
import { __testResetInboxAdapters, type InboxAdapter } from "../../engine/src/inbox/registry.ts";
import type { InboxItem, InboxKind, InboxListContext } from "../../engine/src/inbox/types.ts";

// Exercise the real count registry and permission check. Only the approval
// database reader and individual task sources are replaced.
const registryUrl = new URL("../../engine/src/inbox/registry.ts", import.meta.url).href;
const stateKey = Symbol.for("openbooks.inbox-count-test");
const state = { approvalTotal: 0, approvalReads: 0, actorId: "user-1", orgId: "org-1" };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith("/inbox-context.ts")) {
      if (specifier === "@openbooks/engine/src/inbox/index.ts") return { url: registryUrl, shortCircuit: true };
      if (specifier === "./application/approvals") return { url: "mock:inbox-count-approvals", shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === "mock:inbox-count-approvals") return {
      format: "module", shortCircuit: true, source: `
        import assert from 'node:assert/strict';
        const state = globalThis[Symbol.for('openbooks.inbox-count-test')];
        export async function approvalWorklistCountForAuthz(authz) {
          assert.equal(authz.user.orgId, state.orgId);
          assert.equal(authz.user.id, state.actorId);
          assert.deepEqual([...authz.allowedSubsidiaryIds], ['sub-1']);
          state.approvalReads++;
          return state.approvalTotal;
        }
      `,
    };
    return next(url, context);
  },
});
const { inboxCounts, inboxTaskFilters } = await import("./inbox-context");
test.after(() => { hooks.deregister(); __testResetInboxAdapters([]); });
test.beforeEach(() => { state.approvalReads = 0; state.approvalTotal = 0; __testResetInboxAdapters([]); });

const ctx: InboxListContext = { orgId: state.orgId, actorId: state.actorId, asOf: "2026-09-30" };
function viewer(permissions: string[] = []): Authz {
  return {
    user: { id: ctx.actorId, orgId: ctx.orgId, email: "viewer@example.test", name: "Viewer", roles: [],
      envKind: "sandbox", productionOrgId: ctx.orgId, isSuperAdmin: false, homeUserId: ctx.actorId, homeOrgId: ctx.orgId },
    permissions: new Set(permissions), allowedSubsidiaryIds: new Set(["sub-1"]),
  };
}
function source(kind: InboxKind, total: number): InboxAdapter {
  return {
    kind,
    async list() { throw new Error("Totals must not materialize a bounded list"); },
    async count(actual) { assert.deepEqual(actual, ctx); return total; },
    async act() { throw new Error("Counting must not write"); },
  };
}

test("one personal task and one unread notice produce the same total as two My Tasks rows", async () => {
  __testResetInboxAdapters([source("hrm_process_step", 1), source("notification", 1)]);
  assert.deepEqual(await inboxCounts(viewer(), ctx), { approvals: 0, tasks: 2, count: 2, notices: [] });
  assert.equal(state.approvalReads, 0, "an actor without approval permission never reads decision rows");
});

test("the badge includes approvals, signatures and full task counts beyond list windows", async () => {
  state.approvalTotal = 7;
  __testResetInboxAdapters([source("hrm_process_step", 41), source("document_signature", 3), source("notification", 1)]);
  assert.deepEqual(await inboxCounts(viewer(["flows.approve"]), ctx), { approvals: 7, tasks: 45, count: 52, notices: [] });
  assert.equal(state.approvalReads, 1);
});

test("a failed task source is named while healthy sources retain their count", async (t) => {
  t.mock.method(console, "error", () => {});
  const broken = source("notification", 0);
  broken.count = async () => { throw new Error("private database details"); };
  __testResetInboxAdapters([source("hrm_process_step", 2), broken]);
  assert.deepEqual(await inboxCounts(viewer(), ctx), {
    approvals: 0, tasks: 2, count: 2,
    notices: [{ kind: "notification", code: "failed", message: "the inbox source could not be read" }],
  });
});

test("task filters share one live population and every subsequent read resolves sources again", async () => {
  const reads = new Map<InboxKind, number>();
  let revoked = false;
  const taskSource = (kind: InboxKind, priority: InboxItem['priority']): InboxAdapter => ({
    kind,
    async list(actual) {
      assert.deepEqual(actual, ctx);
      reads.set(kind, (reads.get(kind) ?? 0) + 1);
      if (revoked && kind === 'hrm_process_step') return [];
      return [{ id: `${kind}:1`, kind, priority, title: kind, subtitle: null,
        createdAt: '2026-09-29T00:00:00Z', dueAt: null, subjectHref: '/inbox', actions: [],
        source: { kind, id: '1' } }];
    },
    async count() { throw new Error('Filter projection must not count or write'); },
    async act() { throw new Error('Filter projection must not act'); },
  });
  __testResetInboxAdapters([
    taskSource('hrm_process_step', 'overdue'),
    taskSource('document_signature', 'normal'),
    taskSource('notification', 'overdue'),
  ]);
  assert.deepEqual(await inboxTaskFilters(ctx, false), {
    filters: { all: [], my_tasks: [], signatures: [], notices: [], overdue: [] }, notices: [],
  });
  assert.equal(reads.size, 0, 'an inactive task view must not read or retain task records');
  const first = await inboxTaskFilters(ctx);
  assert.equal(first.filters.all.length, 3);
  assert.deepEqual(first.filters.my_tasks.map((item) => item.kind), ['hrm_process_step']);
  assert.deepEqual(first.filters.signatures.map((item) => item.kind), ['document_signature']);
  assert.deepEqual(first.filters.notices.map((item) => item.kind), ['notification']);
  assert.deepEqual(new Set(first.filters.overdue.map((item) => item.kind)), new Set(['hrm_process_step', 'notification']));
  assert.deepEqual([...reads.values()], [1, 1, 1]);
  assert.ok(first.filters.overdue.every((item) => first.filters.all.includes(item)), 'filters retain source item identity and native actions');
  revoked = true;
  const second = await inboxTaskFilters(ctx);
  assert.equal(second.filters.all.length, 2);
  assert.deepEqual(second.filters.my_tasks, []);
  assert.deepEqual([...reads.values()], [2, 2, 2]);
});

test("one unavailable task source names one sanitized notice without losing healthy filters", async (t) => {
  t.mock.method(console, 'error', () => {});
  __testResetInboxAdapters([{
    kind: 'notification',
    async list() { throw new Error('private driver details'); },
    async act() { throw new Error('Reading must not act'); },
  }, {
    kind: 'document_signature',
    async list() { return [{ id: 'document_signature:1', kind: 'document_signature', priority: 'normal',
      title: 'Signature', subtitle: null, createdAt: '2026-09-29T00:00:00Z', dueAt: null,
      subjectHref: '/documents', actions: [], source: { kind: 'document', id: '1' } }]; },
    async act() { throw new Error('Reading must not act'); },
  }]);
  const result = await inboxTaskFilters(ctx);
  assert.equal(result.filters.all.length, 1);
  assert.equal(result.filters.signatures.length, 1);
  assert.deepEqual(result.filters.notices, []);
  assert.deepEqual(result.notices, [{ kind: 'notification', code: 'failed', message: 'the inbox source could not be read' }]);
});
