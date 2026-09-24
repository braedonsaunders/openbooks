import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import nodeTest from "node:test";
import { NextResponse } from "next/server";
import { LeaveError } from "@openbooks/engine/src/hrm/leave-errors.ts";

/**
 * Withdraw boundary: the reason is required by the REAL body parser, and
 * service refusals map through the REAL _lib. Authz, features and the
 * service are doubles; the service double rethrows REAL LeaveErrors.
 */

interface RouteState {
  gate: { user: { id: string; orgId: string } } | { status: number };
  featureOn: boolean;
  calls: Array<{ fn: string; args: unknown }>;
  serviceThrow: unknown;
}

const stateKey = Symbol.for("openbooks.hrm-leave-withdraw-route-test");
const test = nodeTest;

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
      const state = globalThis[Symbol.for('openbooks.hrm-leave-withdraw-route-test')]
      export async function guardPermission(permission) {
        if (permission !== 'hrm.leave.request') throw new Error('unexpected permission ' + permission)
        if (state.gate && 'status' in state.gate) {
          const NextResponse = globalThis.openbooksHrmLeaveWithdrawRouteNextResponse
          return NextResponse.json({ error: 'denied' }, { status: state.gate.status })
        }
        return state.gate
      }
    `,
  ],
  [
    "mock:features",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-leave-withdraw-route-test')]
      export async function isFeatureEnabled(orgId, key) {
        if (key !== 'hrm') throw new Error('unexpected feature ' + key)
        return state.featureOn
      }
    `,
  ],
  [
    "mock:service",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-leave-withdraw-route-test')]
      export async function withdrawLeaveRequest(args) {
        state.calls.push({ fn: 'withdraw', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: args.requestId, status: 'withdrawn' }
      }
    `,
  ],
]);

(globalThis as typeof globalThis & Record<string, unknown>).openbooksHrmLeaveWithdrawRouteNextResponse = NextResponse;

const mockUrls = new Map<string, string>([
  ["../../../../../../lib/authz", "mock:authz"],
  ["../../../../../../lib/features", "mock:features"],
  ["@openbooks/engine/src/hrm/leave.ts", "mock:service"],
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
  const routeUrl = "./route.ts?hrm-leave-withdraw";
  const withdrawRoute: typeof import("./route.ts") | undefined = (await import(routeUrl)) as typeof import("./route.ts");
  hooks.deregister();


const REQUEST_ID = "00000000-0000-4000-8000-000000000031";
const ctx = { params: Promise.resolve({ id: REQUEST_ID }) };

function reset(): void {
  routeState.gate = { user: { id: "user-1", orgId: "org-1" } };
  routeState.featureOn = true;
  routeState.calls = [];
  routeState.serviceThrow = null;
}

function jsonRequest(body: unknown): Request {
  return new Request("http://x/api/hrm/leave-requests/x/withdraw", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("withdraw maps a terminal-state refusal with message intact", async () => {
  reset();
  routeState.serviceThrow = new LeaveError(
    "BAD_STATE",
    "a approved request cannot be withdrawn — cancel it instead",
  );
  const res = await withdrawRoute!.POST(jsonRequest({ reason: "too late" }), ctx);
  assert.equal(res.status, 409);
  assert.ok(!res.ok);
  assert.match(((await res.json()) as { error: string }).error, /cancel it instead/);
});

test("withdraw forwards a non-uuid id and the gate", async () => {
  reset();
  const bad = await withdrawRoute!.POST(jsonRequest({ reason: "x" }), { params: Promise.resolve({ id: "nope" }) });
  assert.equal(bad.status, 400);
  reset();
  routeState.gate = { status: 403 };
  const denied = await withdrawRoute!.POST(jsonRequest({ reason: "x" }), ctx);
  assert.equal(denied.status, 403);
});
