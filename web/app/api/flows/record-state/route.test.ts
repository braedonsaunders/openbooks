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
  // Scope is decided by the locking resolver (mock:lib), not
  // the old check-then-read guard seam. The lock stub records every subject
  // subsidiary it evaluates here.
  lockChecks: Array<string | null>;
  statusCalls: string[];
  runRows: Array<Record<string, unknown>>;
  canRetry: boolean;
  canRead: boolean;
  readChecks: string[];
  flowsEnabled: boolean;
  flowQueries: number;
}

const stateKey = Symbol.for("openbooks.flow-record-state-route-test");
const routeState: RouteState = {
  authz: {
    user: { id: "user-1", orgId: "org-1" },
    allowedSubsidiaryIds: new Set(),
  },
  subjectSubsidiaryId: "sub-hidden",
  status: "pending_approval",
  lockChecks: [],
  statusCalls: [],
  runRows: [],
  canRetry: false,
  canRead: true,
  readChecks: [],
  flowsEnabled: true,
  flowQueries: 0,
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
        state.flowQueries += 1
        if (JSON.stringify(query).includes('flow_runs')) return { rows: state.runRows ?? [] }
        return { rows: [] }
      } }
      export async function withOrgContext(_orgId, fn) { return fn() }
      export async function withOrgTransaction(_orgId, fn) { return fn() }
    `,
  ],
  [
    "mock:flows",
    `
      const state = globalThis[Symbol.for('openbooks.flow-record-state-route-test')]
      export function getFlowAdapter(subjectKind) {
        if (subjectKind === 'ungoverned_kind') return null
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
      export async function getAuthz() { return state.authz }
      export function can() { return state.canRetry ?? false }
    `,
  ],
  [
    "mock:lib",
    `
      import { ScopeNotFoundError } from '@openbooks/engine/src/organization/subsidiary-scope.ts'
      const state = globalThis[Symbol.for('openbooks.flow-record-state-route-test')]
      export async function requireFlowsRecordReader() {
        return { authz: state.authz, flowsEnabled: state.flowsEnabled }
      }
      export async function loadFlowSubjectSubsidiary() { return state.subjectSubsidiaryId }
      export async function lockFlowSubjectScope(_subjectKind, _subjectId, _orgId, allowedSubsidiaryIds) {
        state.lockChecks.push(state.subjectSubsidiaryId ?? null)
        if (allowedSubsidiaryIds !== null &&
            (state.subjectSubsidiaryId === null || !allowedSubsidiaryIds.has(state.subjectSubsidiaryId))) {
          throw new ScopeNotFoundError()
        }
      }
    `,
  ],
  [
    "mock:subject-authz",
    `
      const state = globalThis[Symbol.for('openbooks.flow-record-state-route-test')]
      export function canReadFlowSubject(authz, subjectKind) {
        state.readChecks.push(subjectKind)
        return state.canRead ?? true
      }
    `,
  ],
]);

const mockUrls = new Map<string, string>([
  ["@openbooks/engine/src/platform/db.ts", "mock:db"],
  ["@openbooks/engine/src/flows/index.ts", "mock:flows"],
  ["../_lib", "mock:lib"],
  ["../../../../lib/authz", "mock:authz"],
  ["@/lib/authz", "mock:authz"],
  ["../../../../lib/flow-subject-authz", "mock:subject-authz"],
]);

const selfUrl = new URL(import.meta.url).href;

registerHooks({
  resolve(specifier, _context, nextResolve) {
    const mocked = mockUrls.get(specifier);
    // Serve the _lib double under a file URL: its lock stub imports the real
    // ScopeNotFoundError, which cannot resolve from an opaque mock: URL.
    if (mocked === "mock:lib") return { url: `${selfUrl}?mock=lib`, shortCircuit: true };
    if (mocked) return { url: mocked, shortCircuit: true };
    return nextResolve(specifier);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url) ?? mockSources.get(`mock:${new URL(url).searchParams.get("mock")}`);
    if (source !== undefined) return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?record-state-subsidiary-scope";
const { GET } = (await import(routeUrl)) as typeof import("./route.ts");
function reset(allowedSubsidiaryIds: Set<string> | null): void {
  routeState.authz.allowedSubsidiaryIds = allowedSubsidiaryIds;
  routeState.subjectSubsidiaryId = "sub-hidden";
  routeState.status = "pending_approval";
  routeState.lockChecks = [];
  routeState.statusCalls = [];
  routeState.runRows = [];
  routeState.canRetry = false;
  routeState.canRead = true;
  routeState.readChecks = [];
  routeState.flowsEnabled = true;
  routeState.flowQueries = 0;
}

const SUBJECT_ID = "11111111-1111-4111-8111-111111111111";

function request(subjectKind = "vendor_bill"): Request {
  return new Request(
    `http://openbooks.test/api/flows/record-state?subjectKind=${subjectKind}&subjectId=${SUBJECT_ID}`,
  );
}

test("a restricted caller cannot read approval state for another subsidiary", async () => {
  reset(new Set(["sub-visible"]));

  const response = await GET(request());

  assert.equal(response.status, 404);
  assert.deepEqual(routeState.lockChecks, ["sub-hidden"]);
  assert.deepEqual(routeState.statusCalls, []);
});

test("an in-scope caller may read approval state", async () => {
  reset(new Set(["sub-hidden"]));

  const response = await GET(request());

  assert.equal(response.status, 200);
  assert.deepEqual(routeState.lockChecks, ["sub-hidden"]);
  assert.deepEqual(routeState.statusCalls, [SUBJECT_ID]);
});

test("a caller without the kind's read grant meets the missing-record answer", async () => {
  reset(new Set(["sub-hidden"]));
  routeState.canRead = false;

  const response = await GET(request());

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "record not found" });
  assert.deepEqual(routeState.readChecks, ["vendor_bill"]);
  assert.deepEqual(routeState.lockChecks, [], "no subsidiary lookup may run");
  assert.deepEqual(routeState.statusCalls, [], "no record read may run");
});

test("the no-read denial is identical to the missing-record denial", async () => {
  reset(new Set(["sub-hidden"]));
  routeState.canRead = false;
  const denied = await (await GET(request())).json();

  routeState.canRead = true;
  routeState.status = null;
  const missing = await (await GET(request())).json();

  assert.deepEqual(denied, missing);
});

/** A latest failed run surfaces for the row retry affordance. */
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

/** A record the engine never saw (no run, no live gate)
 * must say so, so the drawer can offer to submit it into the current flow
 * instead of claiming no approvals are required. */
test("a pending record with no run at all surfaces as neverSubmitted", async () => {
  reset(new Set(["sub-hidden"]));
  routeState.status = "pending";
  routeState.runRows = [];

  const response = await GET(request());

  assert.equal(response.status, 200);
  const body = (await response.json()) as { neverSubmitted: boolean };
  assert.equal(body.neverSubmitted, true);
});

test("a record with any run history is not neverSubmitted", async () => {
  reset(new Set(["sub-hidden"]));
  routeState.status = "pending";
  routeState.runRows = [
    {
      id: "run-1",
      status: "waiting",
      error: null,
      finishedAt: null,
      startedAt: new Date("2026-09-10T12:00:00.000Z"),
      submitterName: null,
    },
  ];

  const response = await GET(request());

  assert.equal(response.status, 200);
  const body = (await response.json()) as { neverSubmitted: boolean };
  assert.equal(body.neverSubmitted, false);
});

test("with Flows off a visible record answers an empty approval state", async () => {
  reset(new Set(["sub-hidden"]));
  routeState.flowsEnabled = false;
  routeState.status = "pending";
  routeState.canRetry = true;

  const response = await GET(request());

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    approvalState: { status: "pending", pendingWith: [], myActions: null },
    history: [],
    failedRun: null,
    neverSubmitted: false,
    canRetry: false,
  });
  assert.deepEqual(routeState.statusCalls, [SUBJECT_ID]);
  assert.equal(routeState.flowQueries, 0, "no gate, run or role read may run");
});

test("with Flows off a hidden record still meets the missing-record answer", async () => {
  reset(new Set(["sub-visible"]));
  routeState.flowsEnabled = false;
  const outOfScope = await GET(request());
  assert.equal(outOfScope.status, 404);

  reset(new Set(["sub-hidden"]));
  routeState.flowsEnabled = false;
  routeState.canRead = false;
  const noGrant = await GET(request());
  assert.equal(noGrant.status, 404);
  assert.deepEqual(await noGrant.json(), { error: "record not found" });

  reset(new Set(["sub-hidden"]));
  routeState.flowsEnabled = false;
  routeState.status = null;
  const missing = await GET(request());
  assert.equal(missing.status, 404);
});

test("a readable vendor payment answers its approval state, never a refusal", async () => {
  reset(new Set(["sub-hidden"]));
  routeState.status = "draft";

  const response = await GET(request("vendor_payment"));

  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    approvalState: { status: string; pendingWith: unknown[]; myActions: unknown };
    history: unknown[];
  };
  assert.equal(body.approvalState.status, "draft");
  assert.deepEqual(body.approvalState.pendingWith, []);
  assert.equal(body.approvalState.myActions, null);
  assert.deepEqual(body.history, []);
  assert.deepEqual(routeState.readChecks, ["vendor_payment"], "the payment's own read grant is enforced");
});

test("a vendor payment the caller cannot read still meets the missing-record answer", async () => {
  reset(new Set(["sub-hidden"]));
  routeState.canRead = false;

  const response = await GET(request("vendor_payment"));

  assert.equal(response.status, 404);
  assert.deepEqual(routeState.statusCalls, [], "no record read may run");
});

test("a kind no flow can govern answers an empty approval state without reading the record", async () => {
  reset(new Set(["sub-hidden"]));

  const response = await GET(request("ungoverned_kind"));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    approvalState: { status: "", pendingWith: [], myActions: null },
    history: [],
    failedRun: null,
    neverSubmitted: false,
    canRetry: false,
  });
  assert.deepEqual(routeState.lockChecks, [], "nothing about the named record is resolved");
  assert.deepEqual(routeState.statusCalls, []);
  assert.equal(routeState.flowQueries, 0);
});
