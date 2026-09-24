import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

const stateKey = Symbol.for("openbooks.cashflow-data-scope-test");
const state: { categories: Record<string, unknown>[] } = { categories: [] };
Object.assign(globalThis, { [stateKey]: state, __cashflowSqlEmpty: sql`` });

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

const mocks = new Map<string, string>([
  ["mock:db", `
    const state = globalThis[Symbol.for("openbooks.cashflow-data-scope-test")];
    const text = globalThis.__cashflowSqlText;
    export const db = { execute: async (query) =>
      text(query).includes("as cats from orgs")
        ? { rows: [{ cats: state.categories }] }
        : { rows: [] } };
  `],
  ["mock:business-date", `
    export async function businessToday() { return "2026-09-01"; }
    export function daysInCivilMonth(year, month) { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }
    export function utcDateFromParts(year, month, day) { return new Date(Date.UTC(year, month - 1, day)); }
  `],
  ["mock:cadence", `
    export function advanceAnchoredMonth(date) { return date; }
    export function lastDayOfMonth(year, month) { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }
  `],
  ["mock:config", `export async function analyticsConfig() { return { weeklyApCap: "0.0000", restrictToSafe: 0 }; }`],
  ["mock:subsidiaries", `export function subsidiaryVisibleFilter() { return globalThis.__cashflowSqlEmpty; }`],
  ["mock:open-items", `export async function openItems() { return []; }`],
  ["mock:money-server", `export async function getMoneyFormatter() { return { money: String, moneyCompact: String }; }`],
  ["mock:org-scope", `export async function resolveOrgId(orgId) { return orgId ?? "org"; }`],
  ["mock:format", `export function monthYearLabel() { return "Sep 2026"; }`],
  ["mock:formula", `export function evaluateFormula() { return "0.0000"; }`],
  ["mock:gl-summary", `export function statementBookExpr() { return globalThis.__cashflowSqlEmpty; }`],
  ["mock:fx-presentation", `
    export async function lineFunctional() { return "0.0000"; }
    export async function presentationCurrency() { return "USD"; }
    export async function presentationRates() { return new Map(); }
  `],
  ["mock:position", `export function buildTimeline() {
    return { weeks: [], totalInflows: "0.0000", totalOutflows: "0.0000", deferredBeyondHorizon: "0.0000" };
  }`],
]);

const moduleMocks: Record<string, string> = {
  "@openbooks/engine/src/platform/db.ts": "mock:db",
  "@openbooks/engine/src/platform/business-date.ts": "mock:business-date",
  "@openbooks/engine/src/billing/cadence.ts": "mock:cadence",
  "./config": "mock:config",
  "../subsidiaries": "mock:subsidiaries",
  "./open-items": "mock:open-items",
  "../money-server": "mock:money-server",
  "../org-scope": "mock:org-scope",
  "../format": "mock:format",
  "./formula": "mock:formula",
  "../gl-summary": "mock:gl-summary",
  "../fx-presentation": "mock:fx-presentation",
  "../cash/cash-position": "mock:position",
};
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (moduleMocks[specifier]) return { shortCircuit: true, url: moduleMocks[specifier] };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mocks.get(url);
    return source === undefined ? nextLoad(url, context) : { format: "module", source, shortCircuit: true };
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
});
