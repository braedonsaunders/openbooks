import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

interface RouteState {
  rows: Record<string, unknown>[];
}

const stateKey = Symbol.for("openbooks.utilization-entries-precision-test");
const state: RouteState = { rows: [] };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;

const mockSources = new Map<string, string>([
  [
    "mock:authz",
    `export async function guardFeaturePermission() {
       return { user: { id: "user-1", orgId: "org-1" } }
     }`,
  ],
  [
    "mock:db",
    `const state = globalThis[Symbol.for("openbooks.utilization-entries-precision-test")]
     export const db = { execute: async () => ({ rows: state.rows }) }`,
  ],
]);

const mockUrls = new Map<string, string>([
  ["../../../../../lib/feature-gates", "mock:authz"],
  ["@openbooks/engine/src/db.ts", "mock:db"],
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

const routeUrl = "./route.ts?utilization-entries-precision-test";
const { GET } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

test("utilization entries preserve exact cost-rate times hours decimals", async () => {
  state.rows = [
    {
      id: "entry-1",
      date: "2026-01-15",
      hours: "1.0001",
      is_billable: false,
      cost_rate: "9007199254740993.1234",
      item_name: "Service",
      employee_name: "Employee",
      project_name: null,
      customer_name: null,
      memo: "",
    },
  ];

  const response = await GET(
    new Request(
      "https://books.example.test/api/analytics/utilization/entries?employee=employee-1&from=2026-01-01&to=2026-01-31",
    ),
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as { entries: Array<{ cost: unknown }> };
  assert.equal(body.entries[0]?.cost, "9008099974666467.2227");
});
