import assert from "node:assert/strict";
import test from "node:test";
import { stubModules } from "../../../testing/stub-modules";
import { resolveEngineSpecifier } from "../../../testing/engine-resolve-hooks";

// Governed equity actions in the Inbox: the requester sees a pending action
// under Submitted by me with its withdrawal, inside their legal-entity
// scope only; an approver whose role carries only the equity grants decides
// it from their tasks.
const stateKey = Symbol.for("openbooks.inbox-equity-submissions-test");
const state: { authz: unknown } = { authz: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.inbox-equity-submissions-test')]
  export async function getAuthz() { return state.authz }
  export async function requirePermission() { return state.authz }
  export function can(authz, permission) { return authz.permissions.has(permission) }
`;
const mockMoney = `
  export async function getMoneyFormatter() { return { money: String, moneyCompact: String } }
`;

stubModules({ intl: true, navigation: false, authz: false, features: false });

const { registerHooks: registerScopedHooks } = await import("node:module");
registerScopedHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "../../../lib/authz" && context.parentURL?.includes("/inbox/")) {
      return { url: "mock:inbox-equity-authz", shortCircuit: true };
    }
    if (specifier === "@/lib/money-server" && context.parentURL?.includes("/inbox/")) {
      return { url: "mock:inbox-equity-money", shortCircuit: true };
    }
    const engineUrl = resolveEngineSpecifier(specifier);
    if (engineUrl) return nextResolve(engineUrl, context);
    if (context.parentURL?.startsWith("mock:")) {
      return nextResolve(specifier, { ...context, parentURL: import.meta.url });
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:inbox-equity-authz") return { format: "module", source: mockAuthz, shortCircuit: true };
    if (url === "mock:inbox-equity-money") return { format: "module", source: mockMoney, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const { withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { installEngineSeams } = await import("@openbooks/engine/composition/install");
const { dropScratchOrgReporting, seedApprovalFlow } = await import("@openbooks/engine/testing/fixtures");
const { setupEquityWorld } = await import("@openbooks/engine/testing/equity-world");
const { changePlanReserve, createPlan } = await import("@openbooks/engine/equity");
const { loadApprovals } = await import("./view.ts");
type Authz = import("@/lib/authz.ts").Authz;

installEngineSeams();
const EQUITY_ACTION_SUBJECT_KIND = "equity_action";
const DB = !!process.env.OPENBOOKS_DB_URL;

function authzFor(orgId: string, userId: string, role: string, permissions: string[], allowedSubsidiaryIds: ReadonlySet<string> | null = null): Authz {
  return {
    user: {
      id: userId, email: `${userId}@test`, name: role, orgId,
      roles: [{ key: role, name: role }],
      envKind: "sandbox", productionOrgId: orgId, isSuperAdmin: false,
      homeUserId: userId, homeOrgId: orgId,
    },
    permissions: new Set(permissions),
    allowedSubsidiaryIds,
  } as Authz;
}

test("a pending equity action is the requester's submission and the equity approver's task", { skip: !DB }, async () => {
  const w = await withBypassContext(() => setupEquityWorld());
  try {
    await withBypassContext(() => seedApprovalFlow(w.org.orgId, {
      subjectKind: EQUITY_ACTION_SUBJECT_KIND,
      assignees: [{ type: "user", userId: w.approverId }],
      mode: "any",
    }));
    const plan = await createPlan({
      orgId: w.org.orgId, actorId: w.managerId, subsidiaryId: w.org.subsidiaryId, code: "EIP", name: "Equity incentive plan",
      shareClassId: w.commonClassId, effectiveOn: "2026-01-01", reservedShares: "4000000", recycleForfeited: true, recycleExpired: true, recycleRepurchased: false,
    });
    const held = await changePlanReserve({ orgId: w.org.orgId, actorId: w.managerId, planId: plan.id, effectiveOn: "2026-07-15", shareDelta: "1000", reason: "Board approved a pool top-up" });
    assert.equal(held.status, "pending_approval");

    state.authz = authzFor(w.org.orgId, w.managerId, "equity_manager", ["equity.read", "equity.manage"]);
    const mine = await withOrgContext(w.org.orgId, () => loadApprovals({ tab: "submitted" }));
    const row = mine!.submittedRows.find((candidate) => candidate.kind === EQUITY_ACTION_SUBJECT_KIND);
    assert.ok(row, "the requester sees the pending action under Submitted by me");
    assert.match(row.documentNumber, /EIP/, "the row names the record the action concerns");
    assert.equal(row.withdrawEndpoint, `/api/equity/requests/${held.requestId}/withdraw`);
    assert.equal(row.href, `/equity?request=${held.requestId}`);
    assert.equal(mine!.submittedTotal, 1);

    // A requester whose legal-entity scope no longer reaches the action does not see it.
    state.authz = authzFor(w.org.orgId, w.managerId, "equity_manager", ["equity.read", "equity.manage"], new Set());
    const outside = await withOrgContext(w.org.orgId, () => loadApprovals({ tab: "submitted" }));
    assert.equal(outside!.submittedRows.some((candidate) => candidate.kind === EQUITY_ACTION_SUBJECT_KIND), false);
    state.authz = authzFor(w.org.orgId, w.managerId, "equity_manager", ["equity.read", "equity.manage"], new Set([w.org.subsidiaryId]));
    const inside = await withOrgContext(w.org.orgId, () => loadApprovals({ tab: "submitted" }));
    assert.equal(inside!.submittedRows.some((candidate) => candidate.kind === EQUITY_ACTION_SUBJECT_KIND), true);

    // The approver holds only the equity grants: the action is among their tasks, ready to decide.
    state.authz = authzFor(w.org.orgId, w.approverId, "equity_approver", ["equity.read", "equity.approve"]);
    const tasks = await withOrgContext(w.org.orgId, () => loadApprovals({ tab: "tasks" }));
    const task = tasks!.taskRows.find((candidate) => candidate.id.startsWith("equity_action:"));
    assert.ok(task, "the approver's tasks list the equity action");
    assert.deepEqual(task.actions.map((action) => action.key), ["approve", "reject"]);
    assert.equal(task.href, `/equity?request=${held.requestId}`);
  } finally {
    await dropScratchOrgReporting(w.org.orgId);
  }
});
