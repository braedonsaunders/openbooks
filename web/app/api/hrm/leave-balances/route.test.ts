import assert from "node:assert/strict";
import { canonicalEngineSpecifier } from "../../../../testing/engine-resolve-hooks.ts";
import { registerHooks } from "node:module";
import nodeTest from "node:test";
import { NextResponse } from "next/server";

/**
 * Balance boundary behind the record-absence form. The effect math
 * (leave-math) is REAL, so the remaining-after below proves the exact
 * decimal path; the engine read is a double that prices the fixture.
 */

interface RouteState {
  gate: { user: { id: string; orgId: string }; permissions: Set<string> };
  calls: Array<{ fn: string; args: unknown }>;
  fixture: Array<Record<string, unknown>>;
}

const stateKey = Symbol.for("openbooks.hrm-leave-balances-route-test");
const test = nodeTest;

const routeState: RouteState = {
  gate: { user: { id: "user-1", orgId: "org-1" }, permissions: new Set(["hrm.leave.manage"]) },
  calls: [],
  fixture: [],
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockSources = new Map<string, string>([
  [
    "mock:authz",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-leave-balances-route-test')]
      export async function getAuthz() { return state.gate }
      export const can = (authz, perm) => authz.permissions.has('*') || authz.permissions.has(perm);
      export async function guardPermission(permission) {
        const NextResponse = globalThis.openbooksHrmLeaveBalancesRouteNextResponse
        if (!can(state.gate, permission)) {
          return NextResponse.json({ error: 'missing permission: ' + permission }, { status: 403 })
        }
        return state.gate
      }
    `,
  ],
  ["mock:features", `export async function isFeatureEnabled() { return true }`],
  [
    "mock:leave-read",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-leave-balances-route-test')]
      export async function leaveToday() { return '2026-08-03' }
      export async function leaveBalancesForEmployment(exec, orgId, actorId, employmentId, asOf) {
        state.calls.push({ fn: 'balances', args: { orgId, actorId, employmentId, asOf } })
        return state.fixture
      }
    `,
  ],
  ["mock:db", `export const db = {}`],
]);

(
  globalThis as typeof globalThis & Record<string, unknown>
).openbooksHrmLeaveBalancesRouteNextResponse = NextResponse;

const mockUrls = new Map<string, string>([
  ["../../../../lib/authz", "mock:authz"],
  ["../../../../lib/features", "mock:features"],
  ["@/lib/authz", "mock:authz"],
  ["@/lib/features", "mock:features"],
  ["@/lib/feature-gates", "mock:authz"],
  ["@openbooks/engine/hrm/leave-read", "mock:leave-read"],
  ["@openbooks/engine/platform/db", "mock:db"],
]);

const hooks = registerHooks({
  resolve(specifier, _context, nextResolve) {
    const mocked =
      mockUrls.get(specifier) ?? mockUrls.get(canonicalEngineSpecifier(specifier) ?? "");
    if (mocked) return { url: mocked, shortCircuit: true };
    return nextResolve(specifier);
  },
  load(url, _context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined) return { format: "module", source, shortCircuit: true };
    return nextLoad(url);
  },
});
const balancesRoute: typeof import("./route.ts") | undefined = (await import(
  new URL("./route.ts?hrm-leave-balances", import.meta.url).href
)) as typeof import("./route.ts");
test.after(() => hooks.deregister());

const EMPLOYMENT_ID = "00000000-0000-4000-8000-000000000021";
const TYPE_ID = "00000000-0000-4000-8000-000000000022";

function reset(permissions: string[] = ["hrm.leave.manage"]): void {
  routeState.gate = { user: { id: "user-1", orgId: "org-1" }, permissions: new Set(permissions) };
  routeState.calls = [];
  routeState.fixture = [
    {
      leaveTypeId: TYPE_ID,
      code: "VAC",
      name: "Vacation",
      entitlement: "120",
      taken: "8",
      pending: "0",
      remaining: "112",
      balance: "112",
      unlimited: false,
    },
  ];
}

test("GET prices the exact remaining-after effect through the native decimal math", async () => {
  reset();
  const res = await balancesRoute!.GET(
    new Request(
      `http://x/api/hrm/leave-balances?employmentId=${EMPLOYMENT_ID}&asOf=2026-08-03&leaveTypeId=${TYPE_ID}&hours=8`,
    ),
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    asOf: string;
    balances: Array<Record<string, unknown>>;
    effect: { leaveTypeId: string; remainingAfter: string | null } | null;
  };
  assert.equal(body.asOf, "2026-08-03");
  assert.equal(body.balances.length, 1);
  assert.deepEqual(
    body.effect,
    { leaveTypeId: TYPE_ID, remainingAfter: "104" },
    "112 minus 8 prices exactly, never a float",
  );
  assert.deepEqual(routeState.calls[0], {
    fn: "balances",
    args: { orgId: "org-1", actorId: "user-1", employmentId: EMPLOYMENT_ID, asOf: "2026-08-03" },
  });
});

test("GET admits a read-only holder — the engine re-checks the employment", async () => {
  reset(["hrm.leave.read"]);
  const res = await balancesRoute!.GET(
    new Request(`http://x/api/hrm/leave-balances?employmentId=${EMPLOYMENT_ID}`),
  );
  assert.equal(res.status, 200);
  assert.equal(routeState.calls.length, 1);
});

test("GET refuses a bad employment id and bad hours before the service", async () => {
  reset();
  const badId = await balancesRoute!.GET(
    new Request("http://x/api/hrm/leave-balances?employmentId=nope"),
  );
  assert.equal(badId.status, 400);
  const badHours = await balancesRoute!.GET(
    new Request(`http://x/api/hrm/leave-balances?employmentId=${EMPLOYMENT_ID}&hours=8.001`),
  );
  assert.equal(badHours.status, 400);
  assert.equal(routeState.calls.length, 0, "the service never runs on a rejected boundary");
});

test("GET without either grant is forbidden before the service", async () => {
  reset([]);
  const res = await balancesRoute!.GET(
    new Request(`http://x/api/hrm/leave-balances?employmentId=${EMPLOYMENT_ID}`),
  );
  assert.equal(res.status, 403);
  assert.equal(routeState.calls.length, 0);
});
