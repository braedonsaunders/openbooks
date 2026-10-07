import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const stateKey = Symbol.for("openbooks.cashflow-data-scope-test");
const state: { categories: Record<string, unknown>[] } = { categories: [] };
Object.assign(globalThis, { [stateKey]: state });

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return "";
  return chunks.map((chunk) => {
    if (typeof chunk === "string") return chunk;
    const value = (chunk as { value?: unknown[] })?.value;
    if (Array.isArray(value)) return value.map(String).join("");
    if ((chunk as { queryChunks?: unknown[] })?.queryChunks) return sqlText(chunk);
    return "";
  }).join("");
}
Object.assign(globalThis, { __cashflowSqlText: sqlText });

const boundaries = new Map<string, string>([
  [new URL("./query.ts", import.meta.url).href, `
    const state = globalThis[Symbol.for("openbooks.cashflow-data-scope-test")];
    export async function analyticsQuery(query) {
      const text = globalThis.__cashflowSqlText(query);
      if (text.includes("as cats from orgs")) return { rows: [{ cats: state.categories }] };
      if (text.includes('base_currency as "baseCurrency"')) return { rows: [{ baseCurrency: "USD" }] };
      return { rows: [] };
    }
  `],
  [new URL("../../../engine/src/platform/business-date.ts", import.meta.url).href, `
    export * from ${JSON.stringify(new URL("../../../engine/src/platform/business-date.ts", import.meta.url).href + "?native")};
    export async function businessToday() { return "2026-09-01"; }
  `],
  [new URL("../cash/open-items.ts", import.meta.url).href, `export async function openItems() { return []; }`],
  [new URL("../fiscal.ts", import.meta.url).href, `
    export async function fiscalStartMonth() { return 1; }
    export async function defaultFiscalCalendarPeriods() { return null; }
  `],
  [new URL("../money-server.ts", import.meta.url).href, `
    import { createMoneyFormatter } from ${JSON.stringify(new URL("../money-format.ts", import.meta.url).href)};
    export async function getMoneyFormatter() { return createMoneyFormatter("en-US", "USD"); }
  `],
  [new URL("../org-scope.ts", import.meta.url).href, `
    export async function resolveOrgId(orgId) {
      if (orgId !== "org") throw new Error("Unexpected cashflow fixture organization");
      return orgId;
    }
  `],
]);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    const source = boundaries.get(resolved.url);
    return source === undefined ? resolved : { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(source) };
  },
});

const { cashflowData } = await import("./cashflow-data.ts");
hooks.deregister();

test("cashflow forecast excludes categories outside a restricted subsidiary view", async () => {
  state.categories = [
    { id: "unattributed", name: "General", method: "manual_recurring", amount: "10.0000", frequency: "weekly" },
    { id: "subsidiary-a", name: "A rent", method: "manual_recurring", amount: "20.0000", frequency: "weekly", subsidiaryIds: ["a"] },
    { id: "subsidiary-b", name: "B rent", method: "manual_recurring", amount: "30.0000", frequency: "weekly", subsidiaryIds: ["b"] },
  ];

  const result = await cashflowData("org", 4, "2026-09-01", new Set(["a"]));

  assert.deepEqual(result.categories.map((category) => category.id), ["subsidiary-a"]);
  assert.equal(result.categories[0]?.total, "80.0000");
  assert.equal(result.weeks.length, 4, "the native timeline retains the selected forecast horizon");
});
