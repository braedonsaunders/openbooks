import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import nodeTest from "node:test";
import { NextResponse } from "next/server";

interface RouteState {
  gate: { user: { id: string; orgId: string } } | { status: number };
  featureOn: boolean;
  today: string;
  calls: Array<{ fn: string; args: unknown }>;
  serviceThrow: unknown;
  mapped: Array<{ error: unknown }>;
}

const stateKey = Symbol.for("openbooks.hrm-retention-route-test");
const isVitest = process.env.VITEST === "true";
type TestFn = typeof nodeTest;
const vitestPackage = "vitest";
const test: TestFn = isVitest
  ? ((await import(vitestPackage)) as unknown as { test: TestFn }).test
  : nodeTest;

const routeState: RouteState = {
  gate: { user: { id: "user-1", orgId: "org-1" } },
  featureOn: true,
  today: "2026-09-20",
  calls: [],
  serviceThrow: null,
  mapped: [],
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockSources = new Map<string, string>([
  [
    "mock:authz",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-retention-route-test')]
      export async function guardPermission(permission) {
        if (permission !== 'hrm.retention.read') throw new Error('unexpected permission ' + permission)
        if (state.gate && 'status' in state.gate) {
          const NextResponse = globalThis.openbooksHrmRetentionRouteNextResponse
          return NextResponse.json({ error: 'denied' }, { status: state.gate.status })
        }
        return state.gate
      }
    `,
  ],
  [
    "mock:features",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-retention-route-test')]
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
    "mock:date",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-retention-route-test')]
      export async function businessToday(orgId) {
        return state.today
      }
    `,
  ],
  [
    "mock:read",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-retention-route-test')]
      export async function getRetentionOverview(args) {
        state.calls.push({ fn: 'overview', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { regrettableLeavers: 0 }
      }
      export async function getTurnover(args) {
        state.calls.push({ fn: 'turnover', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { periods: [] }
      }
    `,
  ],
  [
    "mock:lib",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-retention-route-test')]
      const NextResponse = globalThis.openbooksHrmRetentionRouteNextResponse
      export function performanceErrorResponse(error) {
        state.mapped.push({ error })
        return NextResponse.json({ error: String((error && error.message) || error) }, { status: 409 })
      }
    `,
  ],
]);

(globalThis as typeof globalThis & Record<string, unknown>).openbooksHrmRetentionRouteNextResponse = NextResponse;

const mockUrls = new Map<string, string>([
  ["../../../../lib/authz", "mock:authz"],
  ["../../../../lib/features", "mock:features"],
  ["../../../../lib/list-params", "mock:list-params"],
  ["@openbooks/engine/src/platform/business-date.ts", "mock:date"],
  ["@openbooks/engine/src/hrm/performance/performance-read.ts", "mock:read"],
  ["../review-cycles/_lib", "mock:lib"],
]);

let retentionRoute: typeof import("./route.ts") | undefined;
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
  const routeUrl = "./route.ts?hrm-retention";
  retentionRoute = (await import(routeUrl)) as typeof import("./route.ts");
  hooks.deregister();
}

function reset(): void {
  routeState.gate = { user: { id: "user-1", orgId: "org-1" } };
  routeState.featureOn = true;
  routeState.calls = [];
  routeState.serviceThrow = null;
  routeState.mapped = [];
}

if (isVitest) {
  test("retention route gates on the retention read grant", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
    assert.match(source, /guardPermission\("hrm\.retention\.read"\)/);
  });
} else {
  test("a missing feature flag 404s before the service runs", async () => {
    reset();
    routeState.featureOn = false;
    assert.equal((await retentionRoute!.GET(new Request("http://openbooks.test/api/hrm/retention"))).status, 404);
    assert.deepEqual(routeState.calls, []);
  });

  test("an unauthenticated caller never reaches the service", async () => {
    reset();
    routeState.gate = { status: 401 };
    assert.equal((await retentionRoute!.GET(new Request("http://openbooks.test/api/hrm/retention"))).status, 401);
    assert.deepEqual(routeState.calls, []);
  });

  test("overview and twelve monthly periods fan out with the caller's identity", async () => {
    reset();
    const response = await retentionRoute!.GET(new Request("http://openbooks.test/api/hrm/retention"));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { overview: { regrettableLeavers: 0 }, turnover: [] });
    const turnover = routeState.calls.find((c) => c.fn === "turnover")!.args as {
      periods: { start: string; end: string }[];
    };
    assert.equal(turnover.periods.length, 12);
    assert.deepEqual(turnover.periods[11], { start: "2026-09-01", end: "2026-09-30" });
    assert.deepEqual(turnover.periods[0], { start: "2025-10-01", end: "2025-10-31" });
  });

  test("a bad department id never reaches the service", async () => {
    reset();
    assert.equal(
      (await retentionRoute!.GET(new Request("http://openbooks.test/api/hrm/retention?departmentId=nope"))).status,
      400,
    );
    assert.deepEqual(routeState.calls, []);
  });

  test("a service refusal delegates to the shared mapping with the error intact", async () => {
    reset();
    const refusal = new Error("retention needs hrm.retention.read");
    routeState.serviceThrow = refusal;
    assert.equal((await retentionRoute!.GET(new Request("http://openbooks.test/api/hrm/retention"))).status, 409);
    assert.equal(routeState.mapped[0]!.error, refusal);
  });
}
