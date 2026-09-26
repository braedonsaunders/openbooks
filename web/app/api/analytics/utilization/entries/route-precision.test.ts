import assert from "node:assert/strict";
import { stubModules } from "../../../../../testing/stub-modules";
import test from "node:test";

interface RouteState {
  rows: Record<string, unknown>[];
}

const stateKey = Symbol.for("openbooks.utilization-entries-precision-test");
const state: RouteState = { rows: [] };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;

stubModules({
  navigation: false,
  intl: false,
  authz: false,
  features: false,
  extra: {
    "../../../../../lib/feature-gates": `export async function guardFeaturePermission() {
       // Unrestricted caller: subsidiary scope is covered by the DB-backed
       // scope test; here the drill must not filter.
       return { user: { id: "user-1", orgId: "org-1" }, allowedSubsidiaryIds: null }
     }`,
    "@openbooks/engine/src/platform/db.ts": `const state = globalThis[Symbol.for("openbooks.utilization-entries-precision-test")]
     export const ambientTenantOrgId = () => null
     export const withBypassContext = (fn) => fn()
     export const db = { execute: async (query) => {
       // The route resolves the presentation currency through the org row;
       // entry fixture rows carry no currency, so they translate 1:1.
       // (The entry query also names base_currency — match the org lookup,
       // whose projection aliases it as "baseCurrency".)
       try {
         if (JSON.stringify(query?.queryChunks ?? "").includes("baseCurrency")) {
           return { rows: [{ baseCurrency: "CAD" }] };
         }
       } catch { /* fall through to entry rows */ }
       return { rows: state.rows };
     } }`,
  },
});

const routeUrl = "./route.ts?utilization-entries-precision-test";
const { GET } = (await import(routeUrl)) as typeof import("./route.ts");

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
