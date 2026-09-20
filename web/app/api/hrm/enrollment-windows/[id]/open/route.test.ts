import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import nodeTest from "node:test";
import { NextResponse } from "next/server";
import { BenefitsError } from "@openbooks/engine/src/hrm/benefits/errors.ts";

/**
 * Window open/close boundary. The close reason is required by the REAL
 * body parser; service refusals map through the REAL _lib. Authz, features
 * and the service are doubles; the double rethrows REAL BenefitsErrors.
 */

interface RouteState {
  gate: { user: { id: string; orgId: string } } | { status: number };
  featureOn: boolean;
  calls: Array<{ fn: string; args: unknown }>;
  serviceThrow: unknown;
}

const stateKey = Symbol.for("openbooks.hrm-benefits-window-open-route-test");
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
      const state = globalThis[Symbol.for('openbooks.hrm-benefits-window-open-route-test')]
      export async function guardPermission(permission) {
        if (permission !== 'hrm.benefits.manage') throw new Error('unexpected permission ' + permission)
        if (state.gate && 'status' in state.gate) {
          const NextResponse = globalThis.openbooksHrmBenefitsWindowOpenRouteNextResponse
          return NextResponse.json({ error: 'denied' }, { status: state.gate.status })
        }
        return state.gate
      }
    `,
  ],
  [
    "mock:features",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-benefits-window-open-route-test')]
      export async function isFeatureEnabled(orgId, key) {
        if (key !== 'hrm') throw new Error('unexpected feature ' + key)
        return state.featureOn
      }
    `,
  ],
  [
    "mock:service",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-benefits-window-open-route-test')]
      export async function openEnrollmentWindow(args) {
        state.calls.push({ fn: 'open', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: args.windowId, status: 'open' }
      }
    `,
  ],
]);

(globalThis as typeof globalThis & Record<string, unknown>).openbooksHrmBenefitsWindowOpenRouteNextResponse =
  NextResponse;

const mockUrls = new Map<string, string>([
  ["../../../../../../lib/authz", "mock:authz"],
  ["../../../../../../lib/features", "mock:features"],
  ["@openbooks/engine/src/hrm/benefits/windows.ts", "mock:service"],
]);

let openRoute: typeof import("./route.ts") | undefined;
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
  const routeUrl = "./route.ts?hrm-benefits-window-open";
  openRoute = (await import(routeUrl)) as typeof import("./route.ts");
  hooks.deregister();
}

const WINDOW_ID = "00000000-0000-4000-8000-000000000031";
const ctx = { params: Promise.resolve({ id: WINDOW_ID }) };

function reset(): void {
  routeState.gate = { user: { id: "user-1", orgId: "org-1" } };
  routeState.featureOn = true;
  routeState.calls = [];
  routeState.serviceThrow = null;
}

function jsonRequest(body: unknown): Request {
  return new Request("http://x/api/hrm/enrollment-windows/x/open", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("POST opens a draft window", async () => {
  reset();
  const res = await openRoute!.POST(jsonRequest({}), ctx);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { window: { status: string } };
  assert.equal(body.window.status, "open");
  assert.deepEqual(routeState.calls[0], {
    fn: "open",
    args: { orgId: "org-1", actorId: "user-1", windowId: WINDOW_ID },
  });
});

test("POST refuses a non-uuid id before the service", async () => {
  reset();
  const bad = await openRoute!.POST(jsonRequest({}), { params: Promise.resolve({ id: "nope" }) });
  assert.equal(bad.status, 400);
  assert.equal(routeState.calls.length, 0);
});

test("POST forwards the gate and the feature switch", async () => {
  reset();
  routeState.gate = { status: 403 };
  assert.equal((await openRoute!.POST(jsonRequest({}), ctx)).status, 403);
  reset();
  routeState.featureOn = false;
  assert.equal((await openRoute!.POST(jsonRequest({}), ctx)).status, 404);
});

test("POST maps the overlap refusal with message intact", async () => {
  reset();
  routeState.serviceThrow = new BenefitsError(
    "REFUSED",
    "enrollment window New overlaps open window Old of the same kind and scope — close Old first so one window covers these people",
  );
  const refused = await openRoute!.POST(jsonRequest({}), ctx);
  assert.equal(refused.status, 422);
  const body = (await refused.json()) as { error: string };
  assert.match(body.error, /close Old first/);
});
