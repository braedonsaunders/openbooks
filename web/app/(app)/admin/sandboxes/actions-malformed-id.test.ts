import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// ID-class follow-up to the enterOrg hardening (ID4): every sandbox admin
// action binds its sandbox/change-set id straight into SQL, so a malformed
// id escapes as a raw Postgres uuid throw instead of failing closed with a
// domain error. Auth is stubbed to a sandbox manager; the guards must fire
// before any database round-trip, so these run without a database.
const stateKey = Symbol.for("openbooks.sandbox-actions-id-test");
interface State {
  authz: unknown;
}
const state: State = { authz: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;

const mocks = new Map<string, string>([
  [
    "mock:authz",
    `
      const state = globalThis[Symbol.for('openbooks.sandbox-actions-id-test')]
      export async function getAuthz() { return state.authz }
      export function can() { return true }
    `,
  ],
  [
    "mock:cache",
    `export function revalidatePath() {}`,
  ],
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier === "../../../../lib/authz") {
      return { url: "mock:authz", shortCircuit: true };
    }
    if (specifier === "next/cache") {
      return { url: "mock:cache", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mocks.get(url);
    if (source !== undefined) return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const actions = (await import("./actions.ts")) as typeof import("./actions.ts");

function managerAuthz(): void {
  state.authz = {
    user: {
      id: "00000000-0000-4000-8000-00000000a001",
      orgId: "00000000-0000-4000-8000-00000000a002",
      productionOrgId: "00000000-0000-4000-8000-00000000a002",
      homeUserId: "00000000-0000-4000-8000-00000000a001",
      homeOrgId: "00000000-0000-4000-8000-00000000a002",
      envKind: "production",
      isSuperAdmin: false,
    },
  };
}

test("sandbox actions fail closed on malformed ids before any database write", async () => {
  managerAuthz();
  await assert.rejects(actions.refreshSandboxAction("not-a-uuid", false), /invalid/i);
  await assert.rejects(actions.resetSandboxAction("not-a-uuid"), /invalid/i);
  await assert.rejects(actions.deleteSandboxAction("not-a-uuid"), /invalid/i);
  await assert.rejects(actions.setScheduleAction("not-a-uuid", "daily"), /invalid/i);
  await assert.rejects(actions.promoteSandboxAction("not-a-uuid", "x"), /invalid/i);
  await assert.rejects(actions.reviewChangeSetAction("not-a-uuid"), /invalid/i);
  await assert.rejects(actions.approveChangeSetAction("not-a-uuid"), /invalid/i);
  await assert.rejects(actions.applyChangeSetAction("not-a-uuid"), /invalid/i);
});
