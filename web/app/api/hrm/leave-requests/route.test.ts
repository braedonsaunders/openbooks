import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import nodeTest from "node:test";
import { NextResponse } from "next/server";
import { LeaveError } from "@openbooks/engine/src/hrm/leave-errors.ts";

/**
 * Leave-request collection boundary.
 *
 * mock:authz (session + grants) and mock:features (the hrm switch) isolate
 * the route from the network; the service double records calls and rethrows
 * REAL LeaveErrors when told — a double that cannot produce the refusal is
 * not a test of the refusal. The JSON boundary (parseJsonBody) and the
 * error mapping (_lib) are REAL: the 400s and the 409/422s below exercise
 * the production code path, not a copy. isUuid is pure and runs as-is.
 */

interface RouteState {
  gate: { user: { id: string; orgId: string } } | { status: number };
  featureOn: boolean;
  calls: Array<{ fn: string; args: unknown }>;
  serviceThrow: unknown;
}

const stateKey = Symbol.for("openbooks.hrm-leave-route-test");
const isVitest = process.env.VITEST === "true";
type TestFn = typeof nodeTest;
const vitestPackage = "vitest";
const test: TestFn = isVitest
  ? ((await import(vitestPackage)) as unknown as { test: TestFn }).test
  : nodeTest;

const routeState: RouteState = {
  gate: { user: { id: "user-1", orgId: "org-1" } },
  featureOn: true,
  calls: [],
  serviceThrow: null,
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockSources = new Map<string, string>([
  [
    "mock:authz",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-leave-route-test')]
      export async function guardPermission(permission) {
        if (permission !== 'hrm.leave.read' && permission !== 'hrm.leave.request') {
          throw new Error('unexpected permission ' + permission)
        }
        if (state.gate && 'status' in state.gate) {
          const NextResponse = globalThis.openbooksHrmLeaveRouteNextResponse
          return NextResponse.json({ error: 'denied' }, { status: state.gate.status })
        }
        return state.gate
      }
    `,
  ],
  [
    "mock:features",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-leave-route-test')]
      export async function isFeatureEnabled(orgId, key) {
        if (key !== 'hrm') throw new Error('unexpected feature ' + key)
        return state.featureOn
      }
    `,
  ],
  [
    "mock:service",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-leave-route-test')]
      export async function fileLeaveRequest(args) {
        state.calls.push({ fn: 'file', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: 'request-1', status: 'draft' }
      }
      export async function listLeaveRequests(args) {
        state.calls.push({ fn: 'list', args })
        if (state.serviceThrow) throw state.serviceThrow
        return [{ id: 'request-1', status: 'submitted' }]
      }
      export async function myLeaveRequests(args) {
        state.calls.push({ fn: 'mine', args })
        if (state.serviceThrow) throw state.serviceThrow
        return [{ id: 'request-9', status: 'draft' }]
      }
    `,
  ],
]);

(globalThis as typeof globalThis & Record<string, unknown>).openbooksHrmLeaveRouteNextResponse = NextResponse;

const mockUrls = new Map<string, string>([
  ["../../../../lib/authz", "mock:authz"],
  ["../../../../lib/features", "mock:features"],
  ["@openbooks/engine/src/hrm/leave.ts", "mock:service"],
  ["@openbooks/engine/src/hrm/leave-read.ts", "mock:service"],
]);

let collectionRoute: typeof import("./route.ts") | undefined;
if (!isVitest) {
  const hooks = registerHooks({
    resolve(specifier, _context, nextResolve) {
      if (specifier === "server-only") {
        return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
      }
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
  const routeUrl = "./route.ts?hrm-leave-collection";
  collectionRoute = (await import(routeUrl)) as typeof import("./route.ts");
  hooks.deregister();
}

const EMPLOYMENT_ID = "00000000-0000-4000-8000-000000000021";
const TYPE_ID = "00000000-0000-4000-8000-000000000022";

function reset(): void {
  routeState.gate = { user: { id: "user-1", orgId: "org-1" } };
  routeState.featureOn = true;
  routeState.calls = [];
  routeState.serviceThrow = null;
}

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const draftBody = {
  employmentId: EMPLOYMENT_ID,
  leaveTypeId: TYPE_ID,
  startsOn: "2026-09-01",
  endsOn: "2026-09-02",
  hours: "16",
  reason: "rest",
};

test("GET lists one employment with status pass-through", { skip: !collectionRoute }, async () => {
  reset();
  const res = await collectionRoute!.GET(
    new Request(`http://x/api/hrm/leave-requests?employmentId=${EMPLOYMENT_ID}&status=submitted`),
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { requests: unknown[] };
  assert.equal(body.requests.length, 1);
  assert.deepEqual(routeState.calls[0], {
    fn: "list",
    args: { orgId: "org-1", actorId: "user-1", employmentId: EMPLOYMENT_ID, status: "submitted" },
  });
});

test("GET mine reads the self-service inbox with no caller-supplied worker", { skip: !collectionRoute }, async () => {
  reset();
  const res = await collectionRoute!.GET(new Request("http://x/api/hrm/leave-requests?employmentId=mine"));
  assert.equal(res.status, 200);
  assert.deepEqual(routeState.calls[0], { fn: "mine", args: { orgId: "org-1", actorId: "user-1" } });
});

test("GET refuses unknown status and non-uuid employment before the service", { skip: !collectionRoute }, async () => {
  reset();
  const badStatus = await collectionRoute!.GET(
    new Request(`http://x/api/hrm/leave-requests?employmentId=${EMPLOYMENT_ID}&status=taken`),
  );
  assert.equal(badStatus.status, 400);
  const badId = await collectionRoute!.GET(new Request("http://x/api/hrm/leave-requests?employmentId=nope"));
  assert.equal(badId.status, 400);
  assert.equal(routeState.calls.length, 0, "the service never runs on a rejected boundary");
});

test("GET forwards the gate and the feature switch", { skip: !collectionRoute }, async () => {
  reset();
  routeState.gate = { status: 403 };
  const denied = await collectionRoute!.GET(new Request("http://x/api/hrm/leave-requests?employmentId=mine"));
  assert.equal(denied.status, 403);
  reset();
  routeState.featureOn = false;
  const off = await collectionRoute!.GET(new Request("http://x/api/hrm/leave-requests?employmentId=mine"));
  assert.equal(off.status, 404);
});

test("POST files a draft through the real body parser", { skip: !collectionRoute }, async () => {
  reset();
  const res = await collectionRoute!.POST(jsonRequest("http://x/api/hrm/leave-requests", draftBody));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { request: { id: string } };
  assert.equal(body.request.id, "request-1");
  assert.deepEqual(routeState.calls[0], {
    fn: "file",
    args: { orgId: "org-1", actorId: "user-1", ...draftBody, reason: "rest", onBehalf: undefined },
  });
});

test("POST refuses a malformed body with 400 and never calls the service", { skip: !collectionRoute }, async () => {
  reset();
  const malformed = await collectionRoute!.POST(jsonRequest("http://x/api/hrm/leave-requests", "{oops"));
  assert.equal(malformed.status, 400);
  const missing = await collectionRoute!.POST(
    jsonRequest("http://x/api/hrm/leave-requests", { leaveTypeId: TYPE_ID }),
  );
  assert.equal(missing.status, 400);
  const missingBody = (await missing.json()) as { issues: Array<{ path: string }> };
  assert.ok(missingBody.issues.some((issue) => issue.path === "employmentId"));
  assert.equal(routeState.calls.length, 0);
});

test("POST maps computed refusals with message intact — status first, body second", { skip: !collectionRoute }, async () => {
  reset();
  routeState.serviceThrow = new LeaveError("REFUSED", "policy time balance is 4 hours but the request needs 16 — shorten it");
  const refused = await collectionRoute!.POST(jsonRequest("http://x/api/hrm/leave-requests", draftBody));
  assert.equal(refused.status, 422);
  assert.ok(!refused.ok);
  const refusedBody = (await refused.json()) as { error: string };
  assert.match(refusedBody.error, /time balance is 4 hours/);

  reset();
  routeState.serviceThrow = new LeaveError("STALE_RUN", "absence day 2026-09-02 is already covered by committed pay run PAY-1 — ask payroll");
  const stale = await collectionRoute!.POST(jsonRequest("http://x/api/hrm/leave-requests", draftBody));
  assert.equal(stale.status, 409);
  assert.match(((await stale.json()) as { error: string }).error, /retro|committed pay run/);
});
