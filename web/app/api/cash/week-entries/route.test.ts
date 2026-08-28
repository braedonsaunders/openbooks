import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

interface CashPositionCall {
  orgId: string;
  horizonWeeks: number;
  apSettings: { weeklyCap: string; restrictToSafe: boolean };
  asOfDate: string | undefined;
  subIds: string[] | undefined;
}

interface RouteState {
  allowedSubsidiaryIds: Set<string> | null;
  cashPositionCalls: CashPositionCall[];
}

const stateKey = Symbol.for("openbooks.cash-week-entries-route-test");
// Vitest is an optional test runner in this workspace; keep its import out of
// the Node test path used by the repository's default suite.
const vitestModuleName: string = "vitest";
const routeState: RouteState = {
  allowedSubsidiaryIds: null,
  cashPositionCalls: [],
};
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockSources = new Map<string, string>([
  [
    "mock:feature-gates",
    `
      const state = globalThis[Symbol.for('openbooks.cash-week-entries-route-test')]
      export async function guardFeaturePermission() {
        return {
          user: { orgId: 'org-1', id: 'user-1' },
          allowedSubsidiaryIds: state.allowedSubsidiaryIds,
        }
      }
    `,
  ],
  [
    "mock:analytics-config",
    `
      export async function analyticsConfig() {
        return { weeklyApCap: 250, restrictToSafe: 1 }
      }
    `,
  ],
  [
    "mock:cash-core",
    `
      export function normalizeMoneyValue(value) {
        return value
      }
    `,
  ],
  [
    "mock:cash-position",
    `
      const state = globalThis[Symbol.for('openbooks.cash-week-entries-route-test')]
      export async function cashPosition(orgId, horizonWeeks, apSettings, asOfDate, subIds) {
        state.cashPositionCalls.push({ orgId, horizonWeeks, apSettings, asOfDate, subIds })
        return {
          weeks: [{
            weekStart: '2026-08-23',
            arEntries: [{ id: 'ar-1' }],
            apEntries: [{ id: 'ap-1' }],
          }],
        }
      }
    `,
  ],
]);

let GET: typeof import("./route.ts")["GET"];
if (process.env.VITEST) {
  const { vi } = await import(vitestModuleName);
  vi["mock"]("../../../../lib/feature-gates", () => ({
    guardFeaturePermission: async () => ({
      user: { orgId: "org-1", id: "user-1" },
      allowedSubsidiaryIds: routeState.allowedSubsidiaryIds,
    }),
  }));
  vi["mock"]("../../../../lib/analytics/config", () => ({
    analyticsConfig: async () => ({ weeklyApCap: 250, restrictToSafe: 1 }),
  }));
  vi["mock"]("../../../../lib/cash/core", () => ({
    normalizeMoneyValue: (value: string) => value,
  }));
  vi["mock"]("../../../../lib/cash/cash-position", () => ({
    cashPosition: async (
      orgId: string,
      horizonWeeks: number,
      apSettings: { weeklyCap: string; restrictToSafe: boolean },
      asOfDate: string | undefined,
      subIds: string[] | undefined,
    ) => {
      routeState.cashPositionCalls.push({ orgId, horizonWeeks, apSettings, asOfDate, subIds });
      return {
        weeks: [{
          weekStart: "2026-08-23",
          arEntries: [{ id: "ar-1" }],
          apEntries: [{ id: "ap-1" }],
        }],
      };
    },
  }));
  ({ GET } = (await import("./route.ts")) as typeof import("./route.ts"));
} else {
  const mockUrls = new Map<string, string>([
    ["../../../../lib/feature-gates", "mock:feature-gates"],
    ["../../../../lib/analytics/config", "mock:analytics-config"],
    ["../../../../lib/cash/core", "mock:cash-core"],
    ["../../../../lib/cash/cash-position", "mock:cash-position"],
  ]);
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      const mocked = mockUrls.get(specifier);
      if (mocked) return { url: mocked, shortCircuit: true };
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      const source = mockSources.get(url);
      if (source !== undefined) return { format: "module", source, shortCircuit: true };
      return nextLoad(url, context);
    },
  });
  ({ GET } = (await import("./route.ts")) as typeof import("./route.ts"));
  hooks.deregister();
}

function reset(allowedSubsidiaryIds: Set<string> | null): void {
  routeState.allowedSubsidiaryIds = allowedSubsidiaryIds;
  routeState.cashPositionCalls.length = 0;
}

function get(query = "week=2026-08-23"): Promise<Response> {
  return GET(new Request(`http://openbooks.test/api/cash/week-entries?${query}`));
}

const restrictedDefault = async () => {
  reset(new Set(["sub-a", "sub-a-child"]));

  const response = await get();

  assert.equal(response.status, 200);
  assert.deepEqual(routeState.cashPositionCalls[0]?.subIds, ["sub-a", "sub-a-child"]);
  assert.deepEqual(await response.json(), {
    weekStart: "2026-08-23",
    arEntries: [{ id: "ar-1" }],
    apEntries: [{ id: "ap-1" }],
  });
};

const restrictedDenied = async () => {
  reset(new Set(["sub-a"]));

  const response = await get("week=2026-08-23&sub=sub-b");

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "not found" });
  assert.deepEqual(routeState.cashPositionCalls, []);
};

const emptyScopeDenied = async () => {
  reset(new Set());

  const response = await get();

  assert.equal(response.status, 404);
  assert.deepEqual(routeState.cashPositionCalls, []);
};

const restrictedAllowed = async () => {
  reset(new Set(["sub-a", "sub-b"]));

  const response = await get("week=2026-08-23&sub=sub-b");

  assert.equal(response.status, 200);
  assert.deepEqual(routeState.cashPositionCalls[0]?.subIds, ["sub-b"]);
};

const unrestricted = async () => {
  reset(null);

  const wholeCompany = await get();
  assert.equal(wholeCompany.status, 200);
  assert.equal(routeState.cashPositionCalls[0]?.subIds, undefined);

  routeState.cashPositionCalls.length = 0;
  const selected = await get("week=2026-08-23&sub=sub-b");
  assert.equal(selected.status, 200);
  assert.deepEqual(routeState.cashPositionCalls[0]?.subIds, ["sub-b"]);
};

if (process.env.VITEST) {
  const { describe, it } = await import(vitestModuleName);
  describe("cash week entries subsidiary scope", () => {
    it("restricted callers inherit every allowed subsidiary when sub is omitted", restrictedDefault);
    it("restricted callers cannot drill into an out-of-scope subsidiary", restrictedDenied);
    it("empty subsidiary scopes fail closed", emptyScopeDenied);
    it("restricted callers may explicitly drill into an allowed subsidiary", restrictedAllowed);
    it("unrestricted callers retain whole-company and explicit subsidiary behavior", unrestricted);
  });
} else {
  test("restricted callers inherit every allowed subsidiary when sub is omitted", restrictedDefault);
  test("restricted callers cannot drill into an out-of-scope subsidiary", restrictedDenied);
  test("empty subsidiary scopes fail closed", emptyScopeDenied);
  test("restricted callers may explicitly drill into an allowed subsidiary", restrictedAllowed);
  test("unrestricted callers retain whole-company and explicit subsidiary behavior", unrestricted);
}
