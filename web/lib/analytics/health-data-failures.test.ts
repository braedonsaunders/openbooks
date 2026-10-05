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
  "@openbooks/engine/src/platform/db.ts": `export function ambientTenantOrgId(){return null} export function registerRequestOrgResolver(){} export async function withBypassContext(work){return work()} export const db={async execute(query){
    const s=globalThis.__healthFailures;const text=globalThis.__healthQuery(query);s.queries.push(text);
    if(s.fail && text.includes(s.fail))throw new Error('injected ledger read failure');
    return {rows:[]};}}`,
  "../money-server": "export async function getMoneyFormatter(){return {money:String,moneyCompact:String}}",
  "../features": "export async function isFeatureEnabled(){return globalThis.__healthFailures.budgets}",
  "./config": "export async function analyticsConfig(){return {insightCriticalPercent:50,insightWarningPercent:75,revenueDeclineAlertPercent:15,revenueTrendAlertPercent:10,marginCompressionPoints:3,breakevenSafetyPercent:10,breakevenComfortPercent:30,budgetOnTrackPercent:10,budgetWatchPercent:25,segmentHhiWarning:1500,segmentHhiCritical:2500,operatingMarginTarget:15,anomalySigma:2}}",
  "./financial-health": `export async function priorFiscalWindow(){return {from:'2025-07-01',to:'2025-07-31'}}
    export async function financialHealth(){const r=(n)=>Number(n).toFixed(4);return {ratios:{profitability:[],liquidity:[],solvency:[],efficiency:[],operating:[]},benchmarks:{targets:{}},figures:{
    revenue:r(0),cogs:r(0),grossProfit:r(0),opex:r(0),operatingIncome:r(0),otherIncome:r(0),otherExpense:r(0),netIncome:r(0),
    revenueGrowth:null,breakevenRevenue:null,operatingLeverage:null,rule40:null}}}`,
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
  assert.deepEqual(result.budget, { scenario: null, rows: [], totals: { budget: "0.0000", actual: "0.0000", variance: "0.0000" }, tolerance: { onTrack: 10, watch: 25 } });
  assert.ok(!state.queries.some(query => query.includes(state.fail)));
});
