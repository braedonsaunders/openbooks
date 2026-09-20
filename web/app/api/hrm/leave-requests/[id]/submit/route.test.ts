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

const stateKey = Symbol.for("openbooks.hrm-leave-submit-route-test");
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
      const state = globalThis[Symbol.for('openbooks.hrm-leave-submit-route-test')]
      export async function guardPermission(permission) {
        if (permission !== 'hrm.leave.request') throw new Error('unexpected permission ' + permission)
        if (state.gate && 'status' in state.gate) {
          const NextResponse = globalThis.openbooksHrmLeaveSubmitRouteNextResponse
          return NextResponse.json({ error: 'denied' }, { status: state.gate.status })
        }
        return state.gate
      }
    `,
  ],
  [
    "mock:features",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-leave-submit-route-test')]
      export async function isFeatureEnabled(orgId, key) {
        if (key !== 'hrm') throw new Error('unexpected feature ' + key)
        return state.featureOn
      }
    `,
  ],
  [
    "mock:service",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-leave-submit-route-test')]
      export async function submitLeaveRequest(args) {
        state.calls.push({ fn: 'submit', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: args.requestId, status: 'submitted' }
      }
    `,
  ],
]);

(globalThis as typeof globalThis & Record<string, unknown>).openbooksHrmLeaveSubmitRouteNextResponse = NextResponse;

const mockUrls = new Map<string, string>([
  ["../../../../../../lib/authz", "mock:authz"],
  ["../../../../../../lib/features", "mock:features"],
  ["@openbooks/engine/src/hrm/leave.ts", "mock:service"],
]);

let submitRoute: typeof import("./route.ts") | undefined;
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
  const routeUrl = "./route.ts?hrm-leave-submit";
  submitRoute = (await import(routeUrl)) as typeof import("./route.ts");
  hooks.deregister();
}

const REQUEST_ID = "00000000-0000-4000-8000-000000000031";
const ctx = { params: Promise.resolve({ id: REQUEST_ID }) };

function reset(): void {
  routeState.gate = { user: { id: "user-1", orgId: "org-1" } };
  routeState.featureOn = true;
  routeState.calls = [];
  routeState.serviceThrow = null;
}

function jsonRequest(body: unknown): Request {
  return new Request("http://x/api/hrm/leave-requests/x/submit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("submit refuses hostile payloads at the real boundary before the service runs", async () => {
  reset();
  // Submit takes no body, but it still parses one: malformed JSON and
  // non-object payloads are refused at the shared boundary — the service
  // never sees them. parseJsonBody here is the real one (never mocked
  // above), so this is a test of the refusal, not of a double.
  for (const body of ["{not json", "null", "[1,2]", '"text"', "42"]) {
    const refused = await submitRoute!.POST(jsonRequest(body), ctx);
    assert.equal(refused.status, 400, `boundary accepted hostile payload: ${body}`);
  }
  assert.deepEqual(routeState.calls, []);
});

test("submit reaches the service with the request id after an empty body", async () => {
  reset();
  const res = await submitRoute!.POST(jsonRequest({}), ctx);
  assert.equal(res.status, 200);
  assert.deepEqual(routeState.calls[0], {
    fn: "submit",
    args: { orgId: "org-1", actorId: "user-1", requestId: REQUEST_ID },
  });
});

test("submit refuses a malformed id before the service", async () => {
  reset();
  const res = await submitRoute!.POST(jsonRequest({}), { params: Promise.resolve({ id: "nope" }) });
  assert.equal(res.status, 400);
  assert.deepEqual(routeState.calls, []);
});

test("submit maps a service refusal to its status", async () => {
  reset();
  routeState.serviceThrow = new LeaveError("BAD_STATE", "the request is not in a submittable state — reopen it first");
  const res = await submitRoute!.POST(jsonRequest({}), ctx);
  assert.equal(res.status, 409);
});
