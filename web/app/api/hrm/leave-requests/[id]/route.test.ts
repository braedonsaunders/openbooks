import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import nodeTest from "node:test";
import { NextResponse } from "next/server";
import { HrmAuthorizationError } from "@openbooks/engine/src/hrm/authorization.ts";

/**
 * Detail boundary: managers read through the employment gate,
 * self-service reads only its own requests, and everyone else is refused.
 * getAuthz/can are doubles (session); the read services are doubles that
 * rethrow REAL authorization errors; _lib, the uuid check, and the feature
 * switch are real.
 */

interface RouteState {
  authz: { user: { id: string; orgId: string } } | null;
  grants: string[];
  featureOn: boolean;
  calls: Array<{ fn: string; args: unknown }>;
  serviceThrow: unknown;
}

const stateKey = Symbol.for("openbooks.hrm-leave-detail-route-test");
const isVitest = process.env.VITEST === "true";
type TestFn = typeof nodeTest;
const vitestPackage = "vitest";
const test: TestFn = isVitest
  ? ((await import(vitestPackage)) as unknown as { test: TestFn }).test
  : nodeTest;

const routeState: RouteState = {
  authz: { user: { id: "user-1", orgId: "org-1" } },
  grants: ["hrm.leave.read"],
  featureOn: true,
  calls: [],
  serviceThrow: null,
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const canned = {
  id: "request-1",
  employmentId: "00000000-0000-4000-8000-000000000021",
  workerPartyId: "00000000-0000-4000-8000-000000000023",
  leaveTypeId: "00000000-0000-4000-8000-000000000022",
  status: "submitted",
};

const mockSources = new Map<string, string>([
  [
    "mock:authz",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-leave-detail-route-test')]
      export async function getAuthz() { return state.authz }
      export function can(authz, perm) { return state.authz !== null && state.grants.includes(perm) }
    `,
  ],
  [
    "mock:features",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-leave-detail-route-test')]
      export async function isFeatureEnabled(orgId, key) {
        if (key !== 'hrm') throw new Error('unexpected feature ' + key)
        return state.featureOn
      }
    `,
  ],
  [
    "mock:service",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-leave-detail-route-test')]
      const canned = globalThis.openbooksHrmLeaveDetailCanned
      export async function getLeaveRequest(args) {
        state.calls.push({ fn: 'get', args })
        if (state.serviceThrow) throw state.serviceThrow
        return canned
      }
      export async function getOwnLeaveRequest(args) {
        state.calls.push({ fn: 'getOwn', args })
        if (state.serviceThrow) throw state.serviceThrow
        return canned
      }
      export async function leaveToday(orgId) { return '2026-09-20' }
      export async function timeBalanceAsOf(exec, orgId, employmentId, leaveTypeId, asOf) {
        state.calls.push({ fn: 'time', args: { orgId, employmentId, leaveTypeId, asOf } })
        return { kind: 'time', balance: '96', unlimited: false }
      }
      export async function payrollBankBalances(orgId, partyId, opts) {
        state.calls.push({ fn: 'value', args: { orgId, partyId, opts } })
        return []
      }
    `,
  ],
]);

(globalThis as typeof globalThis & Record<string, unknown>).openbooksHrmLeaveDetailCanned = canned;
(globalThis as typeof globalThis & Record<string, unknown>).openbooksHrmLeaveDetailNextResponse = NextResponse;

const mockUrls = new Map<string, string>([
  ["../../../../../lib/authz", "mock:authz"],
  ["../../../../../lib/features", "mock:features"],
  ["@openbooks/engine/src/hrm/leave-read.ts", "mock:service"],
]);

let detailRoute: typeof import("./route.ts") | undefined;
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
  const routeUrl = "./route.ts?hrm-leave-detail";
  detailRoute = (await import(routeUrl)) as typeof import("./route.ts");
  hooks.deregister();
}

const REQUEST_ID = "00000000-0000-4000-8000-000000000031";
const ctx = { params: Promise.resolve({ id: REQUEST_ID }) };

function reset(): void {
  routeState.authz = { user: { id: "user-1", orgId: "org-1" } };
  routeState.grants = ["hrm.leave.read"];
  routeState.featureOn = true;
  routeState.calls = [];
  routeState.serviceThrow = null;
}

test("managers read through the employment gate with time and value balances", async () => {
  reset();
  const res = await detailRoute!.GET(new Request("http://x"), ctx);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    request: { id: string };
    timeBalance: { kind: string };
    valueBalances: unknown[];
    asOf: string;
  };
  assert.equal(body.request.id, "request-1");
  assert.equal(body.timeBalance.kind, "time");
  assert.deepEqual(body.valueBalances, []);
  assert.equal(body.asOf, "2026-09-20");
  const fns = routeState.calls.map((call) => call.fn);
  assert.ok(fns.includes("get") && fns.includes("time") && fns.includes("value"));
  assert.ok(!fns.includes("getOwn"), "the manager path never takes the self-service read");
});

test("self-service reads only its own requests", async () => {
  reset();
  routeState.grants = ["hrm.leave.request"];
  const res = await detailRoute!.GET(new Request("http://x"), ctx);
  assert.equal(res.status, 200);
  assert.ok(routeState.calls.some((call) => call.fn === "getOwn"));
  assert.ok(!routeState.calls.some((call) => call.fn === "get"));
});

test("a stranger's refusal reaches the caller with its message intact", async () => {
  reset();
  routeState.grants = ["hrm.leave.request"];
  routeState.serviceThrow = new HrmAuthorizationError(
    "this leave request is not on your employment — open it from your own inbox",
  );
  const res = await detailRoute!.GET(new Request("http://x"), ctx);
  assert.equal(res.status, 403);
  assert.ok(!res.ok);
  assert.match(((await res.json()) as { error: string }).error, /your own inbox/);
});

test("unauthorized, switched-off, and non-uuid requests fail closed", async () => {
  reset();
  routeState.authz = null;
  assert.equal((await detailRoute!.GET(new Request("http://x"), ctx)).status, 401);
  reset();
  routeState.featureOn = false;
  assert.equal((await detailRoute!.GET(new Request("http://x"), ctx)).status, 404);
  reset();
  assert.equal(
    (await detailRoute!.GET(new Request("http://x"), { params: Promise.resolve({ id: "nope" }) })).status,
    400,
  );
});
