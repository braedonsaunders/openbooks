import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import nodeTest from "node:test";
import { NextResponse } from "next/server";

interface RouteState {
  employmentGate: { user: { id: string; orgId: string } } | { status: number };
  selfGate: { user: { id: string; orgId: string } } | { status: number };
  calls: Array<{ fn: string; args: unknown }>;
}

const stateKey = Symbol.for("openbooks.hrm-employment-record-route-test");
const isVitest = process.env.VITEST === "true";
type TestFn = typeof nodeTest;
const vitestPackage = "vitest";
const test: TestFn = isVitest
  ? ((await import(vitestPackage)) as unknown as { test: TestFn }).test
  : nodeTest;

const routeState: RouteState = {
  employmentGate: { user: { id: "user-1", orgId: "org-1" } },
  selfGate: { user: { id: "user-1", orgId: "org-1" } },
  calls: [],
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockSources = new Map<string, string>([
  [
    "mock:gates",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-employment-record-route-test')]
      const NextResponse = globalThis.openbooksHrmEmploymentRecordNextResponse
      function outcome(gate) {
        if (gate && 'status' in gate) return NextResponse.json({ error: 'denied' }, { status: gate.status })
        return gate
      }
      export async function guardFeaturePermission(permission, feature) {
        if (feature !== 'hrm') throw new Error('unexpected feature ' + feature)
        if (permission === 'hrm.employment.read') return outcome(state.employmentGate)
        if (permission === 'hrm.self.read') return outcome(state.selfGate)
        throw new Error('unexpected permission ' + permission)
      }
    `,
  ],
  [
    "mock:service",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-employment-record-route-test')]
      export class EmploymentReadError extends Error {}
      export async function getEmploymentRecord(args) {
        state.calls.push({ fn: 'record', args })
        return { record: { employmentId: args.employmentId } }
      }
    `,
  ],
  [
    "mock:business-date",
    `
      export async function businessToday(orgId) {
        return '2026-09-20'
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
]);

(globalThis as typeof globalThis & Record<string, unknown>).openbooksHrmEmploymentRecordNextResponse =
  NextResponse;

const mockUrls = new Map<string, string>([
  ["../../../../../lib/feature-gates", "mock:gates"],
  ["@openbooks/engine/src/hrm/employment-read.ts", "mock:service"],
  ["@openbooks/engine/src/platform/business-date.ts", "mock:business-date"],
  ["../../../../../lib/list-params", "mock:list-params"],
]);

let recordRoute: typeof import("./route.ts") | undefined;
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
  const routeUrl: string = "./route.ts?hrm-employment-record";
  recordRoute = (await import(routeUrl)) as typeof import("./route.ts");
  hooks.deregister();
}

const EMPLOYMENT_ID = "00000000-0000-4000-8000-000000000021";

function reset(): void {
  routeState.employmentGate = { user: { id: "user-1", orgId: "org-1" } };
  routeState.selfGate = { user: { id: "user-1", orgId: "org-1" } };
  routeState.calls = [];
}

function getRequest(): { req: Request; ctx: { params: Promise<{ id: string }> } } {
  return {
    req: new Request(`http://openbooks.test/api/hrm/employments/${EMPLOYMENT_ID}?effectiveDate=2026-09-20`),
    ctx: { params: Promise.resolve({ id: EMPLOYMENT_ID }) },
  };
}

test("an employment reader reaches the record through the first gate", async () => {
  reset();
  const { req, ctx } = getRequest();
  const response = await recordRoute!.GET(req, ctx);
  assert.equal(response.status, 200);
  assert.equal(routeState.calls.length, 1);
  const call = routeState.calls[0] as { fn: string; args: Record<string, unknown> };
  assert.equal(call.fn, "record");
  assert.equal(call.args.orgId, "org-1");
  assert.equal(call.args.actorId, "user-1");
  assert.equal(call.args.employmentId, EMPLOYMENT_ID);
  assert.equal(call.args.effectiveDate, "2026-09-20");
});

test("a manager without the employment grant reaches the record through the self fallback", async () => {
  reset();
  routeState.employmentGate = { status: 403 };
  const { req, ctx } = getRequest();
  const response = await recordRoute!.GET(req, ctx);
  assert.equal(response.status, 200);
  assert.equal(routeState.calls.length, 1);
});

test("a caller with neither grant keeps the employment denial", async () => {
  reset();
  routeState.employmentGate = { status: 403 };
  routeState.selfGate = { status: 403 };
  const { req, ctx } = getRequest();
  const response = await recordRoute!.GET(req, ctx);
  assert.equal(response.status, 403);
  assert.deepEqual(routeState.calls, []);
});
