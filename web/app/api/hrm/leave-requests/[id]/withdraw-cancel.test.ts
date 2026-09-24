import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import nodeTest from "node:test";
import { NextResponse } from "next/server";

/**
 * F3-66 (security): Withdraw and Cancel rendered for read-only viewers, and
 * an empty reason posted. The routes must refuse both shapes even if a
 * caller reaches them directly: no hrm.leave.request grant -> 403 with the
 * service never called; an empty reason -> 400 with the service never
 * called. getAuthz/can/isFeatureEnabled are session doubles; guardPermission
 * keeps the production logic over the doubled session; bodies, parseJsonBody,
 * _lib, and the uuid check are real.
 */

interface RouteState {
  signedIn: boolean;
  grants: string[];
  calls: Array<{ fn: string; args: unknown }>;
}

const stateKey = Symbol.for("openbooks.hrm-leave-action-route-test");
const isVitest = process.env.VITEST === "true";
type TestFn = typeof nodeTest;
const vitestPackage = "vitest";
const test: TestFn = isVitest
  ? ((await import(vitestPackage)) as unknown as { test: TestFn }).test
  : nodeTest;

const routeState: RouteState = { signedIn: true, grants: ["hrm.leave.request"], calls: [] };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockSources = new Map<string, string>([
  [
    "mock:authz",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-leave-action-route-test')]
      const NextResponse = globalThis.openbooksHrmLeaveActionNextResponse
      export async function getAuthz() {
        return state.signedIn ? { user: { id: 'user-1', orgId: 'org-1' }, permissions: state.grants } : null
      }
      export function can(authz, perm) { return authz !== null && authz.permissions.includes(perm) }
      export async function guardPermission(perm) {
        const authz = await getAuthz()
        if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
        if (!can(authz, perm)) return NextResponse.json({ error: 'missing permission: ' + perm }, { status: 403 })
        return authz
      }
    `,
  ],
  [
    "mock:features",
    `export async function isFeatureEnabled() { return true }`,
  ],
  [
    "mock:service",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-leave-action-route-test')]
      export async function withdrawLeaveRequest(args) {
        state.calls.push({ fn: 'withdraw', args })
        return { id: args.requestId, status: 'withdrawn' }
      }
      export async function cancelLeaveRequest(args) {
        state.calls.push({ fn: 'cancel', args })
        return { id: args.requestId, status: 'cancelled' }
      }
    `,
  ],
]);

(globalThis as typeof globalThis & Record<string, unknown>).openbooksHrmLeaveActionNextResponse = NextResponse;

const mockUrls = new Map<string, string>([
  ["../../../../../../lib/authz", "mock:authz"],
  ["../../../../../../lib/features", "mock:features"],
  ["@openbooks/engine/src/hrm/leave.ts", "mock:service"],
]);

let withdrawRoute: { POST: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response> } | undefined;
let cancelRoute: { POST: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response> } | undefined;
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
  const withdrawUrl = "./withdraw/route.ts?hrm-leave-withdraw";
  const cancelUrl = "./cancel/route.ts?hrm-leave-cancel";
  withdrawRoute = (await import(withdrawUrl)) as typeof import("./withdraw/route.ts");
  cancelRoute = (await import(cancelUrl)) as typeof import("./cancel/route.ts");
  hooks.deregister();
}

const REQUEST_ID = "00000000-0000-4000-8000-000000000031";
const ctx = { params: Promise.resolve({ id: REQUEST_ID }) };

function post(route: NonNullable<typeof withdrawRoute>, body: unknown): Promise<Response> {
  return route.POST(
    new Request("http://x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    ctx,
  );
}

function reset(grants: string[]): void {
  routeState.signedIn = true;
  routeState.grants = grants;
  routeState.calls = [];
}

test("withdraw refuses a read-only viewer before reaching the service", async () => {
  reset(["hrm.leave.read"]);
  const res = await post(withdrawRoute!, { reason: "Plans changed" });
  assert.equal(res.status, 403);
  assert.match(((await res.json()) as { error: string }).error, /hrm\.leave\.request/);
  assert.deepEqual(routeState.calls, [], "the service must never run for an ungranted actor");
});

test("withdraw refuses an empty reason without reaching the service", async () => {
  for (const reason of ["", "   "]) {
    reset(["hrm.leave.request"]);
    const res = await post(withdrawRoute!, { reason });
    assert.equal(res.status, 400, `empty reason ${JSON.stringify(reason)} must fail closed`);
    assert.deepEqual(routeState.calls, [], "the service must never run for an empty reason");
  }
});

test("withdraw with a grant and a reason reaches the service", async () => {
  reset(["hrm.leave.request"]);
  const res = await post(withdrawRoute!, { reason: "Plans changed" });
  assert.equal(res.status, 200);
  assert.deepEqual(routeState.calls.map((call) => call.fn), ["withdraw"]);
});

test("cancel refuses a read-only viewer and an empty reason", async () => {
  reset(["hrm.leave.read"]);
  assert.equal((await post(cancelRoute!, { reason: "No longer needed" })).status, 403);
  reset(["hrm.leave.request"]);
  assert.equal((await post(cancelRoute!, { reason: "" })).status, 400);
  assert.deepEqual(routeState.calls, [], "the service must never run for either refusal");
});

test("cancel with a grant and a reason reaches the service", async () => {
  reset(["hrm.leave.request"]);
  assert.equal((await post(cancelRoute!, { reason: "No longer needed" })).status, 200);
  assert.deepEqual(routeState.calls.map((call) => call.fn), ["cancel"]);
});
