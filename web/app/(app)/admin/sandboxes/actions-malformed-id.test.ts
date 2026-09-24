import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// ID-class follow-up to the enterOrg hardening (ID4): every sandbox admin
// action binds its sandbox/change-set id straight into SQL, so a malformed
// id escapes as a raw Postgres uuid throw instead of failing closed with a
// domain error. Auth is stubbed to a sandbox manager; the guards must fire
// before any database round-trip, so these run without a database.
const stateKey = Symbol.for("openbooks.sandbox-actions-id-test");
interface EnqueueCall {
  data: unknown;
  options: unknown;
}
interface State {
  authz: unknown;
  enqueues: EnqueueCall[];
}
const state: State = { authz: null, enqueues: [] };
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
  [
    "mock:jobs",
    `
      const state = globalThis[Symbol.for('openbooks.sandbox-actions-id-test')]
      export async function enqueueSandboxOp(data, options) {
        state.enqueues.push({ data, options });
        return { id: options?.jobId ?? 'mock-job' };
      }
    `,
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
    if (specifier === "@openbooks/jobs") {
      return { url: "mock:jobs", shortCircuit: true };
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

const OP_KEY = "00000000-0000-4000-8000-00000000b001";
const OTHER_OP_KEY = "00000000-0000-4000-8000-00000000b002";

test("sandbox actions fail closed on malformed ids before any database write", async () => {
  managerAuthz();
  await assert.rejects(actions.refreshSandboxAction("not-a-uuid", false, OP_KEY), /invalid/i);
  await assert.rejects(actions.resetSandboxAction("not-a-uuid", OP_KEY), /invalid/i);
  await assert.rejects(actions.deleteSandboxAction("not-a-uuid", OP_KEY), /invalid/i);
  await assert.rejects(actions.setScheduleAction("not-a-uuid", "daily"), /invalid/i);
  await assert.rejects(actions.promoteSandboxAction("not-a-uuid", "x"), /invalid/i);
  await assert.rejects(actions.reviewChangeSetAction("not-a-uuid"), /invalid/i);
  await assert.rejects(actions.approveChangeSetAction("not-a-uuid"), /invalid/i);
  await assert.rejects(actions.applyChangeSetAction("not-a-uuid"), /invalid/i);
});

test("the same operation intent enqueues the same deterministic job id", async () => {
  managerAuthz();
  state.enqueues = [];
  const input = { name: "QA", tier: "masked" as const, clientOpKey: OP_KEY };
  await actions.createSandboxAction(input);
  await actions.createSandboxAction(input);
  assert.equal(state.enqueues.length, 2);
  const first = (state.enqueues[0]!.options as { jobId?: unknown }).jobId;
  const second = (state.enqueues[1]!.options as { jobId?: unknown }).jobId;
  assert.ok(typeof first === "string" && first.length > 0, "every enqueue carries a job id");
  assert.equal(second, first, "a double-click with the same intent key must dedupe in BullMQ");
});

test("a new intent key mints a new job id so later operations are never swallowed", async () => {
  managerAuthz();
  state.enqueues = [];
  await actions.createSandboxAction({ name: "QA", tier: "masked", clientOpKey: OP_KEY });
  await actions.createSandboxAction({ name: "QA", tier: "masked", clientOpKey: OTHER_OP_KEY });
  const ids = state.enqueues.map((call) => (call.options as { jobId?: unknown }).jobId);
  assert.ok(ids.every((id) => typeof id === "string" && id.length > 0));
  assert.notEqual(ids[1], ids[0]);
});

test("sandbox enqueues refuse a malformed intent key", async () => {
  managerAuthz();
  await assert.rejects(
    actions.createSandboxAction({ name: "QA", tier: "masked", clientOpKey: "not-a-key" }),
    /invalid/i,
  );
});

test("as-of sandbox creation refuses synchronously before enqueue without a cutoff", async () => {
  managerAuthz();
  state.enqueues = [];
  await assert.rejects(
    actions.createSandboxAction({ name: "Historical QA", tier: "as_of", clientOpKey: OP_KEY }),
    /as-of sandbox requires a cutoff period/,
  );
  assert.equal(state.enqueues.length, 0, "invalid as-of operation must never reach the worker queue");
});
