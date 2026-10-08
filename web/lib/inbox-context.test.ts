import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import type { Authz } from "./authz";
import { __testResetInboxAdapters, type InboxAdapter } from "../../engine/src/inbox/registry.ts";
import type { InboxKind, InboxListContext } from "../../engine/src/inbox/types.ts";

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
const { inboxCounts } = await import("./inbox-context");
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
    notices: [{ kind: "notification", message: "the inbox source could not be read" }],
  });
});
