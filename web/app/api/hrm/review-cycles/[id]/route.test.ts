import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import nodeTest from "node:test";
import { NextResponse } from "next/server";

interface RouteState {
  gate: { user: { id: string; orgId: string } } | { status: number };
  authz: { user: { id: string; orgId: string } } | null;
  featureOn: boolean;
  calls: Array<{ fn: string; args: unknown }>;
  serviceThrow: unknown;
  mapped: Array<{ error: unknown }>;
}

const stateKey = Symbol.for("openbooks.hrm-review-cycle-item-route-test");
const isVitest = process.env.VITEST === "true";
type TestFn = typeof nodeTest;
const vitestPackage = "vitest";
const test: TestFn = isVitest
  ? ((await import(vitestPackage)) as unknown as { test: TestFn }).test
  : nodeTest;

const routeState: RouteState = {
  gate: { user: { id: "user-1", orgId: "org-1" } },
  authz: { user: { id: "user-1", orgId: "org-1" } },
  featureOn: true,
  calls: [],
  serviceThrow: null,
  mapped: [],
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockSources = new Map<string, string>([
  [
    "mock:authz",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-review-cycle-item-route-test')]
      export async function guardPermission(permission) {
        if (permission !== 'hrm.performance.manage') throw new Error('unexpected permission ' + permission)
        if (state.gate && 'status' in state.gate) {
          const NextResponse = globalThis.openbooksHrmReviewCycleItemRouteNextResponse
          return NextResponse.json({ error: 'denied' }, { status: state.gate.status })
        }
        return state.gate
      }
      export async function getAuthz() {
        return state.authz
      }
    `,
  ],
  [
    "mock:features",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-review-cycle-item-route-test')]
      export async function isFeatureEnabled(orgId, key) {
        if (key !== 'hrm') throw new Error('unexpected feature ' + key)
        return state.featureOn
      }
    `,
  ],
  [
    "mock:list-params",
    `
      export function isUuid(value) {
        return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
      }
    `,
  ],
  [
    "mock:service",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-review-cycle-item-route-test')]
      export async function openCycle(args) {
        state.calls.push({ fn: 'open', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { cycle: { id: args.cycleId }, instantiated: 1, managerReviews: 0, gaps: 0 }
      }
      export async function moveToCalibrating(args) {
        state.calls.push({ fn: 'calibrating', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: args.cycleId }
      }
      export async function closeCycle(args) {
        state.calls.push({ fn: 'close', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: args.cycleId }
      }
    `,
  ],
  [
    "mock:read",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-review-cycle-item-route-test')]
      export async function getCycleDetail(args) {
        state.calls.push({ fn: 'detail', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: args.cycleId, reviews: [] }
      }
    `,
  ],
  [
    "mock:lib",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-review-cycle-item-route-test')]
      const NextResponse = globalThis.openbooksHrmReviewCycleItemRouteNextResponse
      export function performanceErrorResponse(error) {
        state.mapped.push({ error })
        return NextResponse.json({ error: String((error && error.message) || error) }, { status: 409 })
      }
    `,
  ],
]);

(globalThis as typeof globalThis & Record<string, unknown>).openbooksHrmReviewCycleItemRouteNextResponse = NextResponse;

const mockUrls = new Map<string, string>([
  ["../../../../../lib/authz", "mock:authz"],
  ["../../../../../lib/features", "mock:features"],
  ["../../../../../lib/list-params", "mock:list-params"],
  ["@openbooks/engine/src/hrm/performance/review-cycles.ts", "mock:service"],
  ["@openbooks/engine/src/hrm/performance/performance-read.ts", "mock:read"],
  ["../_lib", "mock:lib"],
]);

let itemRoute: typeof import("./route.ts") | undefined;
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
  const routeUrl = "./route.ts?hrm-review-cycle-item";
  itemRoute = (await import(routeUrl)) as typeof import("./route.ts");
  hooks.deregister();
}

const CYCLE_ID = "00000000-0000-4000-8000-000000000041";
const params = { params: Promise.resolve({ id: CYCLE_ID }) };

function reset(): void {
  routeState.gate = { user: { id: "user-1", orgId: "org-1" } };
  routeState.authz = { user: { id: "user-1", orgId: "org-1" } };
  routeState.featureOn = true;
  routeState.calls = [];
  routeState.serviceThrow = null;
  routeState.mapped = [];
}

function patchRequest(body: unknown): Request {
  return new Request(`http://openbooks.test/api/hrm/review-cycles/${CYCLE_ID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("a missing feature flag 404s before the service runs", async () => {
  reset();
  routeState.featureOn = false;
  assert.equal((await itemRoute!.GET(new Request("http://openbooks.test/x"), params)).status, 404);
  assert.deepEqual(routeState.calls, []);
});

test("an unauthenticated caller never reaches the service", async () => {
  reset();
  routeState.authz = null;
  routeState.gate = { status: 401 };
  assert.equal((await itemRoute!.GET(new Request("http://openbooks.test/x"), params)).status, 401);
  assert.equal((await itemRoute!.PATCH(patchRequest({ action: "open" }), params)).status, 401);
  assert.deepEqual(routeState.calls, []);
});

test("an unknown id never reaches the service", async () => {
  reset();
  const bad = { params: Promise.resolve({ id: "nope" }) };
  assert.equal((await itemRoute!.GET(new Request("http://openbooks.test/x"), bad)).status, 400);
  assert.equal((await itemRoute!.PATCH(patchRequest({ action: "open" }), bad)).status, 400);
  assert.deepEqual(routeState.calls, []);
});

test("detail resolves through the privacy scope", async () => {
  reset();
  const response = await itemRoute!.GET(new Request("http://openbooks.test/x"), params);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { cycle: { id: CYCLE_ID, reviews: [] } });
  assert.deepEqual(routeState.calls, [
    { fn: "detail", args: { orgId: "org-1", actorId: "user-1", cycleId: CYCLE_ID } },
  ]);
});

test("actions discriminate and validate at the real boundary", async () => {
  reset();
  assert.equal((await itemRoute!.PATCH(patchRequest({}), params)).status, 400);
  assert.equal((await itemRoute!.PATCH(patchRequest({ action: "close-it" }), params)).status, 400);
  assert.equal((await itemRoute!.PATCH(patchRequest({ action: "to-calibrating", force: true }), params)).status, 200);
  assert.equal(
    (await itemRoute!.PATCH(patchRequest({ action: "to-calibrating", force: true, forceReason: "  " }), params)).status,
    400,
  );
  assert.deepEqual(routeState.calls, [
    {
      fn: "calibrating",
      args: { orgId: "org-1", actorId: "user-1", cycleId: CYCLE_ID, force: true, forceReason: undefined },
    },
  ]);
});

test("open and close reach the service with the record id", async () => {
  reset();
  assert.equal((await itemRoute!.PATCH(patchRequest({ action: "open" }), params)).status, 200);
  assert.equal((await itemRoute!.PATCH(patchRequest({ action: "close" }), params)).status, 200);
  assert.deepEqual(routeState.calls.map((c) => c.fn), ["open", "close"]);
});

test("action routes refuse hostile payloads at the real boundary", async () => {
  reset();
  for (const body of ["{not json", "null", "[1,2]", '"text"', "42"]) {
    const refused = await itemRoute!.PATCH(
      new Request(`http://openbooks.test/api/hrm/review-cycles/${CYCLE_ID}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body,
      }),
      params,
    );
    assert.equal(refused.status, 400, `boundary accepted hostile payload: ${body}`);
  }
  assert.deepEqual(routeState.calls, []);
});

test("a service refusal delegates to the shared mapping with the error intact", async () => {
  reset();
  const refusal = new Error("1 pending manager reviews with required answers");
  routeState.serviceThrow = refusal;
  const response = await itemRoute!.PATCH(patchRequest({ action: "to-calibrating" }), params);
  assert.equal(response.status, 409);
  assert.equal(routeState.mapped[0]!.error, refusal);
});
