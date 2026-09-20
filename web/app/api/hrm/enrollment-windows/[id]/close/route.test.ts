import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import nodeTest from "node:test";
import { NextResponse } from "next/server";
import { BenefitsError } from "@openbooks/engine/src/hrm/benefits/errors.ts";

/**
 * Window close boundary: the reason is required by the REAL parser, and a
 * close of a non-open window maps through the REAL _lib to 409.
 */

interface RouteState {
  gate: { user: { id: string; orgId: string } } | { status: number };
  featureOn: boolean;
  calls: Array<{ fn: string; args: unknown }>;
  serviceThrow: unknown;
}

const stateKey = Symbol.for("openbooks.hrm-benefits-window-close-route-test");
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
      const state = globalThis[Symbol.for('openbooks.hrm-benefits-window-close-route-test')]
      export async function guardPermission(permission) {
        if (permission !== 'hrm.benefits.manage') throw new Error('unexpected permission ' + permission)
        if (state.gate && 'status' in state.gate) {
          const NextResponse = globalThis.openbooksHrmBenefitsWindowCloseRouteNextResponse
          return NextResponse.json({ error: 'denied' }, { status: state.gate.status })
        }
        return state.gate
      }
    `,
  ],
  [
    "mock:features",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-benefits-window-close-route-test')]
      export async function isFeatureEnabled(orgId, key) {
        if (key !== 'hrm') throw new Error('unexpected feature ' + key)
        return state.featureOn
      }
    `,
  ],
  [
    "mock:service",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-benefits-window-close-route-test')]
      export async function closeEnrollmentWindow(args) {
        state.calls.push({ fn: 'close', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: args.windowId, status: 'closed' }
      }
    `,
  ],
]);

(globalThis as typeof globalThis & Record<string, unknown>).openbooksHrmBenefitsWindowCloseRouteNextResponse =
  NextResponse;

const mockUrls = new Map<string, string>([
  ["../../../../../../lib/authz", "mock:authz"],
  ["../../../../../../lib/features", "mock:features"],
  ["@openbooks/engine/src/hrm/benefits/windows.ts", "mock:service"],
]);

let closeRoute: typeof import("./route.ts") | undefined;
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
  const routeUrl = "./route.ts?hrm-benefits-window-close";
  closeRoute = (await import(routeUrl)) as typeof import("./route.ts");
  hooks.deregister();
}

const WINDOW_ID = "00000000-0000-4000-8000-000000000032";
const ctx = { params: Promise.resolve({ id: WINDOW_ID }) };

function reset(): void {
  routeState.gate = { user: { id: "user-1", orgId: "org-1" } };
  routeState.featureOn = true;
  routeState.calls = [];
  routeState.serviceThrow = null;
}

function jsonRequest(body: unknown): Request {
  return new Request("http://x/api/hrm/enrollment-windows/x/close", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("POST closes with the reason through the real parser", async () => {
  reset();
  const res = await closeRoute!.POST(jsonRequest({ reason: "year ended" }), ctx);
  assert.equal(res.status, 200);
  assert.deepEqual(routeState.calls[0], {
    fn: "close",
    args: { orgId: "org-1", actorId: "user-1", windowId: WINDOW_ID, reason: "year ended" },
  });
});

test("POST refuses a blank reason with 400 and never calls the service", async () => {
  reset();
  const bad = await closeRoute!.POST(jsonRequest({ reason: "  " }), ctx);
  assert.equal(bad.status, 400);
  assert.equal(routeState.calls.length, 0);
});

test("POST maps a non-open close to 409 with message intact", async () => {
  reset();
  routeState.serviceThrow = new BenefitsError("BAD_STATE", "enrollment window Fall is closed — only an open window closes");
  const refused = await closeRoute!.POST(jsonRequest({ reason: "year ended" }), ctx);
  assert.equal(refused.status, 409);
  const body = (await refused.json()) as { error: string };
  assert.match(body.error, /only an open window closes/);
});
