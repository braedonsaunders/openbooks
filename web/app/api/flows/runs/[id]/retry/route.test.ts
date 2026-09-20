import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";

interface RetryState {
  authz: {
    user: { orgId: string; id: string };
    allowedSubsidiaryIds: Set<string> | null;
  };
  run: { subjectKind: string; subjectId: string } | null;
  subjectSubsidiaryId: string | null;
  scopeChecks: Array<string | null>;
  subjectLoads: Array<{ subjectKind: string; subjectId: string; orgId: string }>;
  headerQueries: number;
  calls: Array<{ runId: string }>;
  mode: { kind: "ok" } | { kind: "fail"; message: string };
}

const stateKey = Symbol.for("openbooks.flow-retry-route-test");
const retryState: RetryState = {
  authz: {
    user: { orgId: "org-1", id: "user-1" },
    allowedSubsidiaryIds: null,
  },
  run: { subjectKind: "vendor_bill", subjectId: "subject-1" },
  subjectSubsidiaryId: "sub-hidden",
  scopeChecks: [],
  subjectLoads: [],
  headerQueries: 0,
  calls: [],
  mode: { kind: "ok" },
};
(
  globalThis as typeof globalThis & Record<symbol, unknown>
)[stateKey] = retryState;

const mockSources = new Map<string, string>([
  [
    "mock:next",
    `
      export class NextResponse extends Response {
        static json(body, init = {}) {
          return new Response(JSON.stringify(body), {
            ...init,
            headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
          })
        }
      }
    `,
  ],
  [
    "mock:drizzle",
    `
      export function sql(strings, ...values) {
        return { strings, values }
      }
    `,
  ],
  [
    "mock:feature-gates",
    `
      const state = globalThis[Symbol.for('openbooks.flow-retry-route-test')]
      export async function guardFeaturePermission() {
        return state.authz
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
  [
    "mock:db",
    `
      const state = globalThis[Symbol.for('openbooks.flow-retry-route-test')]
      export const db = {
        execute: async () => {
          state.headerQueries += 1
          return { rows: state.run ? [state.run] : [] }
        },
      }
    `,
  ],
  [
    "mock:lib",
    `
      const state = globalThis[Symbol.for('openbooks.flow-retry-route-test')]
      export async function loadFlowSubjectSubsidiary(subjectKind, subjectId, orgId) {
        state.subjectLoads.push({ subjectKind, subjectId, orgId })
        return state.subjectSubsidiaryId
      }
    `,
  ],
  [
    "mock:authz",
    `
      const state = globalThis[Symbol.for('openbooks.flow-retry-route-test')]
      export function guardSubsidiaryScope(authz, subsidiaryId) {
        state.scopeChecks.push(subsidiaryId ?? null)
        if (authz.allowedSubsidiaryIds !== null &&
            (subsidiaryId === null || !authz.allowedSubsidiaryIds.has(subsidiaryId))) {
          return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
        }
        return null
      }
    `,
  ],
]);

const mockUrls = new Map<string, string>([
  ["next/server", "mock:next"],
  ["drizzle-orm", "mock:drizzle"],
  ["../../../../../../lib/feature-gates", "mock:feature-gates"],
  ["../../../../../../lib/list-params", "mock:list-params"],
  ["@openbooks/engine/src/flows/index.ts", "mock:engine"],
  ["@openbooks/engine/src/platform/db.ts", "mock:db"],
  ["../../../_lib", "mock:lib"],
  ["../../../../../../lib/authz", "mock:authz"],
]);

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

const flow_retryUrl = './route.ts?flow-retry'
const { POST } = (await import(flow_retryUrl)) as typeof import('./route.ts');
hooks.deregister();

const RUN_ID = "019f0000-0000-4000-8000-000000000001";
const SUBJECT_SUBSIDIARY = "sub-hidden";
const NOT_FOUND = { error: "not found" };

function reset(allowedSubsidiaryIds: Set<string> | null): void {
  retryState.authz.allowedSubsidiaryIds = allowedSubsidiaryIds;
  retryState.run = { subjectKind: "vendor_bill", subjectId: "subject-1" };
  retryState.subjectSubsidiaryId = SUBJECT_SUBSIDIARY;
  retryState.scopeChecks = [];
  retryState.subjectLoads = [];
  retryState.headerQueries = 0;
  retryState.calls = [];
  retryState.mode = { kind: "ok" };
}

function post(id: string) {
  return POST(
    new Request("http://localhost:4800/api/flows/runs/retry", { method: "POST" }),
    { params: Promise.resolve({ id }) },
  );
}

const routeSource = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

test("retry enforces subsidiary scope before re-driving the run", () => {
  assert.match(routeSource, /loadFlowSubjectSubsidiary\(run\.subjectKind, run\.subjectId, orgId\)/);
  assert.match(routeSource, /guardSubsidiaryScope\(\s*gate,\s*await loadFlowSubjectSubsidiary/);
  assert.ok(
    routeSource.indexOf("guardSubsidiaryScope(") < routeSource.lastIndexOf("retryFlowRun("),
    "scope must settle before the engine retry",
  );
  assert.match(routeSource, /from flow_runs/);
});

/** F-t04-004: the retry route refuses a non-uuid run id without touching the engine. */
test("retry refuses a malformed run id", async () => {
  reset(null);
  const res = await post("nope");
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), NOT_FOUND);
  assert.equal(retryState.headerQueries, 0);
  assert.deepEqual(retryState.calls, []);
});

test("missing and out-of-scope run ids return the same 404 and never retry", async () => {
  reset(new Set(["sub-visible"]));
  retryState.run = null;
  const missing = await post(RUN_ID);
  const missingBody = await missing.json();
  assert.equal(missing.status, 404);
  assert.deepEqual(missingBody, NOT_FOUND);
  assert.equal(retryState.headerQueries, 1);
  assert.deepEqual(retryState.subjectLoads, []);
  assert.deepEqual(retryState.calls, []);

  reset(new Set(["sub-visible"]));
  const denied = await post(RUN_ID);
  const deniedBody = await denied.json();
  assert.equal(denied.status, 404);
  assert.deepEqual(deniedBody, NOT_FOUND);
  assert.deepEqual(deniedBody, missingBody);
  assert.deepEqual(retryState.subjectLoads, [
    { subjectKind: "vendor_bill", subjectId: "subject-1", orgId: "org-1" },
  ]);
  assert.deepEqual(retryState.scopeChecks, [SUBJECT_SUBSIDIARY]);
  assert.deepEqual(retryState.calls, []);
});

test("an unresolved subject subsidiary is refused for a restricted caller", async () => {
  reset(new Set(["sub-visible"]));
  retryState.subjectSubsidiaryId = null;
  const res = await post(RUN_ID);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), NOT_FOUND);
  assert.deepEqual(retryState.scopeChecks, [null]);
  assert.deepEqual(retryState.calls, []);
});

/** F-t04-004: engine retry refusals surface as typed 4xx bodies, never 500s. */
test("retry maps a retry refusal to 422", async () => {
  reset(new Set([SUBJECT_SUBSIDIARY]));
  retryState.mode = { kind: "fail", message: "only a failed run can be retried" };
  const res = await post(RUN_ID);
  assert.equal(res.status, 422);
  const body = (await res.json()) as { error?: string };
  assert.match(body.error ?? "", /only a failed run/);
  assert.deepEqual(retryState.scopeChecks, [SUBJECT_SUBSIDIARY]);
  assert.deepEqual(retryState.calls, [{ runId: RUN_ID }]);
});

test("retry maps a missing-run race to 404 after the scope gate", async () => {
  reset(new Set([SUBJECT_SUBSIDIARY]));
  retryState.mode = { kind: "fail", message: "flow run not found" };
  const res = await post(RUN_ID);
  assert.equal(res.status, 404);
  assert.deepEqual(retryState.calls, [{ runId: RUN_ID }]);
});

test("an in-scope caller may retry the run", async () => {
  reset(new Set([SUBJECT_SUBSIDIARY]));
  const res = await post(RUN_ID);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { runId?: string; status?: string; gatesCreated?: number };
  assert.deepEqual(body, { runId: RUN_ID, status: "waiting", gatesCreated: 1 });
  assert.deepEqual(retryState.calls, [{ runId: RUN_ID }]);
});
