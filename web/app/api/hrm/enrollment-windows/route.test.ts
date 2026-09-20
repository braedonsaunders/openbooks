import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import nodeTest from "node:test";
import { NextResponse } from "next/server";
import { BenefitsError } from "@openbooks/engine/src/hrm/benefits/errors.ts";

/**
 * Enrollment-window collection boundary.
 *
 * mock:authz (session + grants) and mock:features (the hrm switch) isolate
 * the route from the network; the service double records calls and rethrows
 * REAL BenefitsErrors when told — a double that cannot produce the refusal
 * is not a test of the refusal. The JSON boundary (parseJsonBody) and the
 * error mapping (_lib) are REAL: the 400s and the 409/422s below exercise
 * the production code path, not a copy.
 */

interface RouteState {
  gate: { user: { id: string; orgId: string } } | { status: number };
  featureOn: boolean;
  calls: Array<{ fn: string; args: unknown }>;
  serviceThrow: unknown;
}

const stateKey = Symbol.for("openbooks.hrm-benefits-windows-route-test");
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
      const state = globalThis[Symbol.for('openbooks.hrm-benefits-windows-route-test')]
      export async function guardPermission(permission) {
        if (permission !== 'hrm.benefits.read' && permission !== 'hrm.benefits.manage') {
          throw new Error('unexpected permission ' + permission)
        }
        if (state.gate && 'status' in state.gate) {
          const NextResponse = globalThis.openbooksHrmBenefitsWindowsRouteNextResponse
          return NextResponse.json({ error: 'denied' }, { status: state.gate.status })
        }
        return state.gate
      }
    `,
  ],
  [
    "mock:features",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-benefits-windows-route-test')]
      export async function isFeatureEnabled(orgId, key) {
        if (key !== 'hrm') throw new Error('unexpected feature ' + key)
        return state.featureOn
      }
    `,
  ],
  [
    "mock:service",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-benefits-windows-route-test')]
      export async function createEnrollmentWindow(args) {
        state.calls.push({ fn: 'create', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: 'window-1', status: 'draft' }
      }
    `,
  ],
  [
    "mock:read",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-benefits-windows-route-test')]
      export const db = {}
      export async function listEnrollmentWindows(exec, orgId, actorId, filter) {
        state.calls.push({ fn: 'list', args: { orgId, actorId, filter } })
        if (state.serviceThrow) throw state.serviceThrow
        return [{ id: 'window-1', status: 'open' }]
      }
    `,
  ],
]);

(globalThis as typeof globalThis & Record<string, unknown>).openbooksHrmBenefitsWindowsRouteNextResponse =
  NextResponse;

const mockUrls = new Map<string, string>([
  ["../../../../lib/authz", "mock:authz"],
  ["../../../../lib/features", "mock:features"],
  ["@openbooks/engine/src/hrm/benefits/windows.ts", "mock:service"],
  ["@openbooks/engine/src/hrm/benefits/benefits-read.ts", "mock:read"],
  ["@openbooks/engine/src/platform/db.ts", "mock:read"],
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
  const routeUrl = "./route.ts?hrm-benefits-windows-collection";
  collectionRoute = (await import(routeUrl)) as typeof import("./route.ts");
  hooks.deregister();
}

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
  name: "2026 enrollment",
  kind: "open_enrollment",
  opensOn: "2026-10-01",
  closesOn: "2026-10-31",
  planYearStartOn: "2026-01-01",
};

test("GET lists windows with status pass-through", async () => {
  reset();
  const res = await collectionRoute!.GET(new Request("http://x/api/hrm/enrollment-windows?status=open"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { windows: unknown[] };
  assert.equal(body.windows.length, 1);
  assert.deepEqual(routeState.calls[0], {
    fn: "list",
    args: { orgId: "org-1", actorId: "user-1", filter: { status: "open" } },
  });
});

test("GET refuses unknown status before the service", async () => {
  reset();
  const bad = await collectionRoute!.GET(new Request("http://x/api/hrm/enrollment-windows?status=archived"));
  assert.equal(bad.status, 400);
  assert.equal(routeState.calls.length, 0, "the service never runs on a rejected boundary");
});

test("GET forwards the gate and the feature switch", async () => {
  reset();
  routeState.gate = { status: 403 };
  const denied = await collectionRoute!.GET(new Request("http://x/api/hrm/enrollment-windows"));
  assert.equal(denied.status, 403);
  reset();
  routeState.featureOn = false;
  const off = await collectionRoute!.GET(new Request("http://x/api/hrm/enrollment-windows"));
  assert.equal(off.status, 404);
});

test("POST creates a draft through the real body parser", async () => {
  reset();
  const res = await collectionRoute!.POST(jsonRequest("http://x/api/hrm/enrollment-windows", draftBody));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { window: { id: string } };
  assert.equal(body.window.id, "window-1");
  assert.deepEqual(routeState.calls[0], {
    fn: "create",
    args: { orgId: "org-1", actorId: "user-1", ...draftBody, employerSubsidiaryId: null, departmentId: null },
  });
});

test("POST refuses a malformed body with 400 and never calls the service", async () => {
  reset();
  const malformed = await collectionRoute!.POST(jsonRequest("http://x/api/hrm/enrollment-windows", "{oops"));
  assert.equal(malformed.status, 400);
  const missing = await collectionRoute!.POST(jsonRequest("http://x/api/hrm/enrollment-windows", { name: "x" }));
  assert.equal(missing.status, 400);
  assert.equal(routeState.calls.length, 0);
});

test("POST maps computed refusals with message intact — status first, body second", async () => {
  reset();
  routeState.serviceThrow = new BenefitsError(
    "REFUSED",
    "enrollment window New overlaps open window Old of the same kind and scope — close Old first so one window covers these people",
  );
  const refused = await collectionRoute!.POST(jsonRequest("http://x/api/hrm/enrollment-windows", draftBody));
  assert.equal(refused.status, 422);
  assert.ok(refused.headers.get("content-type")!.includes("application/json"));
  const body = (await refused.json()) as { error: string };
  assert.match(body.error, /close Old first/);
});
