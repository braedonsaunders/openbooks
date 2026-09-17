import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

interface RouteState {
  authz: {
    user: { id: string; orgId: string };
    allowedSubsidiaryIds: Set<string> | null;
  };
  subjectSubsidiaryId: string | null;
  status: string | null;
  scopeChecks: Array<string | null>;
  statusCalls: string[];
  runRows: Array<Record<string, unknown>>;
  canRetry: boolean;
}

const stateKey = Symbol.for("openbooks.flow-record-state-route-test");
const routeState: RouteState = {
  authz: {
    user: { id: "user-1", orgId: "org-1" },
    allowedSubsidiaryIds: new Set(),
  },
  subjectSubsidiaryId: "sub-hidden",
  status: "pending_approval",
  scopeChecks: [],
  statusCalls: [],
  runRows: [],
  canRetry: false,
};
(
  globalThis as typeof globalThis & Record<symbol, unknown>
)[stateKey] = routeState;

const mockSources = new Map<string, string>([
  [
    "mock:db",
    `
      const state = globalThis[Symbol.for('openbooks.flow-record-state-route-test')]
      export const db = { execute: async (query) => {
        if (JSON.stringify(query).includes('flow_runs')) return { rows: state.runRows ?? [] }
        return { rows: [] }
      } }
      export async function withOrgContext(_orgId, fn) { return fn() }
    `,
  ],
  [
    "mock:flows",
    `
      const state = globalThis[Symbol.for('openbooks.flow-record-state-route-test')]
      export function getFlowAdapter() {
        return {
          async getStatus(subjectId) {
            state.statusCalls.push(subjectId)
            return state.status
          }
        }
      }
      export async function gateDecisionCapability() {
        return { canAct: false, signatureRequired: false }
      }
    `,
  ],
  [
    "mock:authz",
    `
      const state = globalThis[Symbol.for('openbooks.flow-record-state-route-test')]
      export function can() { return state.canRetry ?? false }
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
  [
    "mock:lib",
    `
      const state = globalThis[Symbol.for('openbooks.flow-record-state-route-test')]
      export async function requireFlowsSession() { return state.authz }
      export async function loadFlowSubjectSubsidiary() { return state.subjectSubsidiaryId }
    `,
  ],
  [
    "mock:list-params",
    `
      export function isUuid(value) { return typeof value === 'string' && value.length > 0 }
    `,
  ],
]);

const mockUrls = new Map<string, string>([
  ["@openbooks/engine/src/db.ts", "mock:db"],
  ["@openbooks/engine/src/flows/index.ts", "mock:flows"],
  ["../_lib", "mock:lib"],
  ["../../../../lib/authz", "mock:authz"],
  ["../../../../lib/list-params", "mock:list-params"],
]);

const hooks = registerHooks({
  resolve(specifier, _context, nextResolve) {
    const mocked = mockUrls.get(specifier);
    if (mocked) return { url: mocked, shortCircuit: true };
    return nextResolve(specifier);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined) return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?record-state-subsidiary-scope";
const { GET } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

function reset(allowedSubsidiaryIds: Set<string> | null): void {
  routeState.authz.allowedSubsidiaryIds = allowedSubsidiaryIds;
  routeState.subjectSubsidiaryId = "sub-hidden";
  routeState.status = "pending_approval";
  routeState.scopeChecks = [];
  routeState.statusCalls = [];
  routeState.runRows = [];
  routeState.canRetry = false;
}

function request(): Request {
  return new Request(
    "http://openbooks.test/api/flows/record-state?subjectKind=vendor_bill&subjectId=subject-1",
  );
}

test("a restricted caller cannot read approval state for another subsidiary", async () => {
  reset(new Set(["sub-visible"]));

  const response = await GET(request());

  assert.equal(response.status, 404);
  assert.deepEqual(routeState.scopeChecks, ["sub-hidden"]);
  assert.deepEqual(routeState.statusCalls, []);
});

test("an in-scope caller may read approval state", async () => {
  reset(new Set(["sub-hidden"]));

  const response = await GET(request());

  assert.equal(response.status, 200);
  assert.deepEqual(routeState.scopeChecks, ["sub-hidden"]);
  assert.deepEqual(routeState.statusCalls, ["subject-1"]);
});

/** F-t04-004: a latest failed run surfaces for the row retry affordance. */
test("a failed latest run surfaces as failedRun with the retry capability", async () => {
  reset(new Set(["sub-hidden"]));
  routeState.canRetry = true;
  routeState.runRows = [
    {
      id: "run-1",
      status: "failed",
      error: 'gate (gate "Approval" resolved to zero assignees)',
      finishedAt: new Date("2026-09-10T12:00:01.000Z"),
      startedAt: new Date("2026-09-10T12:00:00.000Z"),
      submitterName: null,
    },
  ];

  const response = await GET(request());

  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    failedRun: { id: string; error: string | null; at: string } | null;
    canRetry: boolean;
  };
  assert.deepEqual(body.failedRun, {
    id: "run-1",
    error: 'gate (gate "Approval" resolved to zero assignees)',
    at: "2026-09-10T12:00:01.000Z",
  });
  assert.equal(body.canRetry, true);
});
