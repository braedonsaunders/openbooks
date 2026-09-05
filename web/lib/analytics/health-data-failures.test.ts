import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";

const state = { fail: "", budgets: true, queries: [] as string[] };
Object.assign(globalThis, { __healthFailures: state });
const dialect = new PgDialect();
Object.assign(globalThis, { __healthQuery: (query: Parameters<PgDialect["sqlToQuery"]>[0]) => dialect.sqlToQuery(query).sql });
const mocks: Record<string, string> = {
  "server-only": "export {}",
  "@openbooks/engine/src/db.ts": `export async function withBypassContext(work){return work()} export const db={async execute(query){
    const s=globalThis.__healthFailures;const text=globalThis.__healthQuery(query);s.queries.push(text);
    if(s.fail && text.includes(s.fail))throw new Error('injected ledger read failure');
    return {rows:[]};}}`,
  "../money-server": "export async function getMoneyFormatter(){return {money:String,moneyCompact:String}}",
  "../features": "export async function isFeatureEnabled(){return globalThis.__healthFailures.budgets}",
  "./financial-health": `export async function financialHealth(){return {figures:{
    revenue:0,cogs:0,grossProfit:0,opex:0,operatingIncome:0,otherExpense:0,netIncome:0,
    revenueGrowth:0,breakevenMonthly:null,operatingLeverage:0,rule40:0}}}`,
};
registerHooks({ resolve(specifier, context, next) {
  if (specifier in mocks) return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(mocks[specifier]!) };
  return next(specifier, context);
} });
const { healthData } = await import("./health-data");
const period = { from: "2026-07-01", to: "2026-07-31", label: "July" };
for (const fragment of ["left join departments", "left join classes", "left join locations", "from budget_scenarios bs", "as current,"]) {
  test(`Financial Health propagates query failures: ${fragment}`, async () => {
    state.fail = fragment; state.budgets = true; state.queries = [];
    await assert.rejects(() => healthData(period, "00000000-0000-4000-8000-000000000001", null), /injected ledger read failure/);
    assert.ok(state.queries.some(query => query.includes(fragment)));
  });
}
test("Financial Health represents genuinely absent data and disabled budgets without querying the budget ledger", async () => {
  state.fail = "from budget_scenarios bs"; state.budgets = false; state.queries = [];
  const result = await healthData(period, "00000000-0000-4000-8000-000000000001", null);
  assert.deepEqual(result.segments, { department: [], class: [], location: [] });
  assert.deepEqual(result.items.rows, []);
  assert.deepEqual(result.budget, { scenario: null, rows: [], totals: { budget: 0, actual: 0, variance: 0 } });
  assert.ok(!state.queries.some(query => query.includes(state.fail)));
});
