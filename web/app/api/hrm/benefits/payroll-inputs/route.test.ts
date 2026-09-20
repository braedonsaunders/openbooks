import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import nodeTest from "node:test";
import { NextResponse } from "next/server";
import { BenefitsError } from "@openbooks/engine/src/hrm/benefits/errors.ts";

/**
 * Benefit payroll-input boundary: generate names a coverage MONTH (never
 * pay periods), void needs a reason. The consumed-month refusal maps
 * through the REAL _lib with the run named.
 */

interface RouteState {
  gate: { user: { id: string; orgId: string } } | { status: number };
  featureOn: boolean;
  calls: Array<{ fn: string; args: unknown }>;
  serviceThrow: unknown;
}

const stateKey = Symbol.for("openbooks.hrm-benefits-payroll-inputs-route-test");
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
      const state = globalThis[Symbol.for('openbooks.hrm-benefits-payroll-inputs-route-test')]
      export async function guardPermission(permission) {
        if (permission !== 'hrm.benefits.manage') throw new Error('unexpected permission ' + permission)
        if (state.gate && 'status' in state.gate) {
          const NextResponse = globalThis.openbooksHrmBenefitsPayrollInputsRouteNextResponse
          return NextResponse.json({ error: 'denied' }, { status: state.gate.status })
        }
        return state.gate
      }
    `,
  ],
  [
    "mock:features",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-benefits-payroll-inputs-route-test')]
      export async function isFeatureEnabled(orgId, key) {
        if (key !== 'hrm') throw new Error('unexpected feature ' + key)
        return state.featureOn
      }
    `,
  ],
  [
    "mock:service",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-benefits-payroll-inputs-route-test')]
      export async function generateBenefitPayrollInputs(args) {
        state.calls.push({ fn: 'generate', args })
        if (state.serviceThrow) throw state.serviceThrow
        return [{ id: 'input-1' }, { id: 'input-2' }]
      }
      export async function voidBenefitPayrollInput(args) {
        state.calls.push({ fn: 'void', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: args.inputId, status: 'voided' }
      }
    `,
  ],
]);

(globalThis as typeof globalThis & Record<string, unknown>).openbooksHrmBenefitsPayrollInputsRouteNextResponse =
  NextResponse;

const mockUrls = new Map<string, string>([
  ["../../../../../lib/authz", "mock:authz"],
  ["../../../../../lib/features", "mock:features"],
  ["@openbooks/engine/src/hrm/benefits/benefits-payroll.ts", "mock:service"],
]);

let inputsRoute: typeof import("./route.ts") | undefined;
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
  const routeUrl = "./route.ts?hrm-benefits-payroll-inputs";
  inputsRoute = (await import(routeUrl)) as typeof import("./route.ts");
  hooks.deregister();
}

function reset(): void {
  routeState.gate = { user: { id: "user-1", orgId: "org-1" } };
  routeState.featureOn = true;
  routeState.calls = [];
  routeState.serviceThrow = null;
}

function jsonRequest(body: unknown): Request {
  return new Request("http://x/api/hrm/benefits/payroll-inputs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("POST generates for a coverage month, never pay periods", async () => {
  reset();
  const res = await inputsRoute!.POST(jsonRequest({ action: "generate", coverageMonth: "2026-03" }));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { inputs: unknown[] };
  assert.equal(body.inputs.length, 2);
  assert.deepEqual(routeState.calls[0], {
    fn: "generate",
    args: { orgId: "org-1", actorId: "user-1", coverageMonth: "2026-03" },
  });
});

test("POST refuses a non-month with 400 and never calls the service", async () => {
  reset();
  assert.equal((await inputsRoute!.POST(jsonRequest({ action: "generate", coverageMonth: "2026-Q1" }))).status, 400);
  assert.equal((await inputsRoute!.POST(jsonRequest({ action: "void", inputId: "nope", reason: "x" }))).status, 400);
  assert.equal(routeState.calls.length, 0);
});

test("POST voids with a reason; reason-less voids are 400", async () => {
  reset();
  const inputId = "00000000-0000-4000-8000-000000000071";
  const res = await inputsRoute!.POST(jsonRequest({ action: "void", inputId, reason: "duplicated month" }));
  assert.equal(res.status, 200);
  assert.deepEqual(routeState.calls[0], {
    fn: "void",
    args: { orgId: "org-1", actorId: "user-1", inputId, reason: "duplicated month" },
  });
  reset();
  assert.equal((await inputsRoute!.POST(jsonRequest({ action: "void", inputId, reason: "  " }))).status, 400);
});

test("POST maps the consumed-month refusal with the run named", async () => {
  reset();
  routeState.serviceThrow = new BenefitsError(
    "REFUSED",
    "coverage 2026-03-01..2026-03-31 for this enrolment is already consumed by pay run 11111111-1111-4111-8111-111111111111 — recalculate the run; HR never rewrites a consumed month",
  );
  const refused = await inputsRoute!.POST(jsonRequest({ action: "generate", coverageMonth: "2026-03" }));
  assert.equal(refused.status, 422);
  const body = (await refused.json()) as { error: string };
  assert.match(body.error, /11111111-1111-4111-8111-111111111111/);
  assert.match(body.error, /recalculate the run/);
});
