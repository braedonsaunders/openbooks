import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import nodeTest from "node:test";
import { NextResponse } from "next/server";

interface RetryState {
  calls: Array<{ runId: string }>;
  mode: { kind: "ok" } | { kind: "fail"; message: string };
}

const stateKey = Symbol.for("openbooks.flow-retry-route-test");
const isVitest = process.env.VITEST === "true";
type TestFn = typeof nodeTest;
const vitestPackage = "vitest";
const test: TestFn = isVitest
  ? ((await import(vitestPackage)) as unknown as { test: TestFn }).test
  : nodeTest;
const retryState: RetryState = {
  calls: [],
  mode: { kind: "ok" },
};
(
  globalThis as typeof globalThis & Record<symbol, unknown>
)[stateKey] = retryState;

const mockSources = new Map<string, string>([
  [
    "mock:feature-gates",
    `
      export async function guardFeaturePermission() {
        return { user: { orgId: 'org-1', id: 'user-1' } }
      }
    `,
  ],
  [
    "mock:list-params",
    `
      export function isUuid(value) {
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value ?? '')
      }
    `,
  ],
  [
    "mock:engine",
    `
      const state = globalThis[Symbol.for('openbooks.flow-retry-route-test')]
      export class FlowRetryError extends Error {}
      export async function retryFlowRun(runId) {
        state.calls.push({ runId })
        if (state.mode.kind === 'fail') throw new FlowRetryError(state.mode.message)
        return { runId, status: 'waiting', gatesCreated: 1 }
      }
    `,
  ],
]);

const mockUrls = new Map<string, string>([
  ["../../../../../../lib/feature-gates", "mock:feature-gates"],
  ["../../../../../../lib/list-params", "mock:list-params"],
  ["@openbooks/engine/src/flows/index.ts", "mock:engine"],
]);

let postRoute: typeof import("./route.ts").POST | undefined;
if (!isVitest) {
  const hooks = registerHooks({
    resolve(specifier, _context, nextResolve) {
      const mocked = mockUrls.get(specifier);
      if (mocked) return { url: mocked, shortCircuit: true };
      return nextResolve(specifier);
    },
    load(url, _context, nextLoad) {
      const source = mockSources.get(url);
      if (source !== undefined) return { format: "module", source, shortCircuit: true };
      return nextLoad(url);
    },
  });

  const routeUrl = "./route.ts?flow-retry";
  postRoute = (await import(routeUrl) as typeof import("./route.ts")).POST;
  hooks.deregister();
}

const RUN_ID = "019f0000-0000-4000-8000-000000000001";

function post(id: string) {
  return postRoute!(
    new Request("http://localhost:4800/api/flows/runs/retry", { method: "POST" }),
    { params: Promise.resolve({ id }) },
  );
}

/** F-t04-004: the retry route refuses a non-uuid run id without touching the engine. */
test("retry refuses a malformed run id", async () => {
  retryState.calls = [];
  retryState.mode = { kind: "ok" };
  const res = (await post("nope")) as NextResponse;
  assert.equal(res.status, 404);
  assert.deepEqual(retryState.calls, []);
});

/** F-t04-004: engine retry refusals surface as typed 4xx bodies, never 500s. */
test("retry maps a retry refusal to 422", async () => {
  retryState.calls = [];
  retryState.mode = { kind: "fail", message: "only a failed run can be retried" };
  const res = (await post(RUN_ID)) as NextResponse;
  assert.equal(res.status, 422);
  const body = (await res.json()) as { error?: string };
  assert.match(body.error ?? "", /only a failed run/);
  assert.deepEqual(retryState.calls, [{ runId: RUN_ID }]);
});

test("retry maps a missing run to 404", async () => {
  retryState.calls = [];
  retryState.mode = { kind: "fail", message: "flow run not found" };
  const res = (await post(RUN_ID)) as NextResponse;
  assert.equal(res.status, 404);
});

test("retry returns the re-driven run", async () => {
  retryState.calls = [];
  retryState.mode = { kind: "ok" };
  const res = (await post(RUN_ID)) as NextResponse;
  assert.equal(res.status, 200);
  const body = (await res.json()) as { runId?: string; status?: string; gatesCreated?: number };
  assert.deepEqual(body, { runId: RUN_ID, status: "waiting", gatesCreated: 1 });
});
