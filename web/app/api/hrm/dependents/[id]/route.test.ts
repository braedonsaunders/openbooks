import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import nodeTest from "node:test";
import { NextResponse } from "next/server";
import { BenefitsError } from "@openbooks/engine/src/hrm/benefits/errors.ts";

/**
 * Dependent edit boundary: descriptors update, retirement deactivates,
 * identity never moves. Refusals map through the REAL _lib.
 */

interface RouteState {
  gate: { user: { id: string; orgId: string } } | { status: number };
  featureOn: boolean;
  calls: Array<{ fn: string; args: unknown }>;
  serviceThrow: unknown;
}

const stateKey = Symbol.for("openbooks.hrm-benefits-dependent-id-route-test");
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
      const state = globalThis[Symbol.for('openbooks.hrm-benefits-dependent-id-route-test')]
      export async function guardPermission(permission) {
        if (permission !== 'hrm.benefits.manage') throw new Error('unexpected permission ' + permission)
        if (state.gate && 'status' in state.gate) {
          const NextResponse = globalThis.openbooksHrmBenefitsDependentIdRouteNextResponse
          return NextResponse.json({ error: 'denied' }, { status: state.gate.status })
        }
        return state.gate
      }
    `,
  ],
  [
    "mock:features",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-benefits-dependent-id-route-test')]
      export async function isFeatureEnabled(orgId, key) {
        if (key !== 'hrm') throw new Error('unexpected feature ' + key)
        return state.featureOn
      }
    `,
  ],
  [
    "mock:service",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-benefits-dependent-id-route-test')]
      export async function updateDependent(args) {
        state.calls.push({ fn: 'update', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: args.dependentId }
      }
      export async function deactivateDependent(args) {
        state.calls.push({ fn: 'deactivate', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: args.dependentId, isActive: false }
      }
    `,
  ],
]);

(globalThis as typeof globalThis & Record<string, unknown>).openbooksHrmBenefitsDependentIdRouteNextResponse =
  NextResponse;

const mockUrls = new Map<string, string>([
  ["../../../../../lib/authz", "mock:authz"],
  ["../../../../../lib/features", "mock:features"],
  ["@openbooks/engine/src/hrm/benefits/dependents.ts", "mock:service"],
]);

let idRoute: typeof import("./route.ts") | undefined;
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
  const routeUrl = "./route.ts?hrm-benefits-dependent-id";
  idRoute = (await import(routeUrl)) as typeof import("./route.ts");
  hooks.deregister();
}

const DEPENDENT_ID = "00000000-0000-4000-8000-000000000081";
const ctx = { params: Promise.resolve({ id: DEPENDENT_ID }) };

function reset(): void {
  routeState.gate = { user: { id: "user-1", orgId: "org-1" } };
  routeState.featureOn = true;
  routeState.calls = [];
  routeState.serviceThrow = null;
}

function patchRequest(body: unknown): Request {
  return new Request("http://x/api/hrm/dependents/x", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("PATCH updates descriptors without moving identity", async () => {
  reset();
  const res = await idRoute!.PATCH(patchRequest({ action: "update", displayName: "Alex R. Partner" }), ctx);
  assert.equal(res.status, 200);
  assert.deepEqual(routeState.calls[0], {
    fn: "update",
    args: { orgId: "org-1", actorId: "user-1", dependentId: DEPENDENT_ID, displayName: "Alex R. Partner", birthDate: undefined },
  });
});

test("PATCH deactivates; blank names are 400", async () => {
  reset();
  const res = await idRoute!.PATCH(patchRequest({ action: "deactivate" }), ctx);
  assert.equal(res.status, 200);
  assert.deepEqual(routeState.calls[0]!.fn, "deactivate");
  reset();
  assert.equal((await idRoute!.PATCH(patchRequest({ action: "update", displayName: "  " }), ctx)).status, 400);
  assert.equal(routeState.calls.length, 0);
});

test("PATCH maps computed refusals with message intact", async () => {
  reset();
  routeState.serviceThrow = new BenefitsError("REFUSED", "dependent not found in this organization — reload and retry");
  const refused = await idRoute!.PATCH(patchRequest({ action: "deactivate" }), ctx);
  assert.equal(refused.status, 422);
  const body = (await refused.json()) as { error: string };
  assert.match(body.error, /not found in this organization/);
});
