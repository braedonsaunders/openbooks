import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// The trailing trend series follows the organization's own fiscal calendar:
// a quarterly calendar prices whole declared quarters labelled with the
// period names, while a monthly calendar keeps calendar months. Only the
// database (and the boundaries around it) is doubled — bucketing,
// translation-free merging and labelling run for real.

const QUARTERS = [
  { fiscalYear: 2026, periodNumber: 1, name: "Q1 FY2026", from: "2026-01-01", to: "2026-03-31" },
  { fiscalYear: 2026, periodNumber: 2, name: "Q2 FY2026", from: "2026-04-01", to: "2026-06-30" },
];

const state = { cadence: "quarterly" };
Object.assign(globalThis, { __healthFiscal: state });
const { PgDialect } = await import("drizzle-orm/pg-core");
const dialect = new PgDialect();
type FiscalQuery = ReturnType<InstanceType<typeof PgDialect>["sqlToQuery"]>;
Object.assign(globalThis, { __healthFiscalQueries: [] as FiscalQuery[] });
Object.assign(globalThis, { __healthFiscalQuery: (query: Parameters<InstanceType<typeof PgDialect>["sqlToQuery"]>[0]) => {
  const built = dialect.sqlToQuery(query);
  (globalThis as unknown as { __healthFiscalQueries: FiscalQuery[] }).__healthFiscalQueries.push(built);
  return built.sql;
} });

const mocks: Record<string, string> = {
  "server-only": "export {}",
  "@openbooks/engine/src/platform/db.ts": `export function ambientTenantOrgId(){return null} export function registerRequestOrgResolver(){} export async function withBypassContext(work){return work()} export const db={async execute(query){
    const text = globalThis.__healthFiscalQuery(query);
    // The fiscal-period series reads journal lines without the monthly rollup
    // and without a dimension join; every other ledger read in this module
    // is irrelevant here.
    if (text.includes("operating_revenue") && !text.includes("gl_month_activity") && !text.includes("departments") && !text.includes("classes") && !text.includes("locations")) {
      return { rows: [
        { month: "period_0", func: null, late: "2026-03-31", revenue: "100", operating_revenue: "100", cogs: "40", opex: "10", other_exp: "0" },
        { month: "period_1", func: null, late: "2026-06-30", revenue: "200", operating_revenue: "200", cogs: "80", opex: "20", other_exp: "0" },
      ] };
    }
    return { rows: [] };}}`,
  "../money-server": "export async function getMoneyFormatter(){return {money:String,moneyCompact:String}}",
  "../features": "export async function isFeatureEnabled(){return false}",
  "../fx-presentation": `export async function flowRates(){ return { rateAt: () => "1" }; }`,
  "../fiscal": `export async function defaultFiscalCalendarPeriods(){ return { cadence: globalThis.__healthFiscal.cadence, periods: ${JSON.stringify(QUARTERS)} }; }`,
  "./config": "export async function analyticsConfig(){return {insightCriticalPercent:50,insightWarningPercent:75,revenueDeclineAlertPercent:15,revenueTrendAlertPercent:10,marginCompressionPoints:3,breakevenSafetyPercent:10,breakevenComfortPercent:30,budgetOnTrackPercent:10,budgetWatchPercent:25,segmentHhiWarning:1500,segmentHhiCritical:2500,operatingMarginTarget:15,forecastMethod:\"ets\",forecastHorizon:\"6\",forecastConfidence:\"90\",forecastSeasonality:\"auto\",forecastAdjustment:\"zero\",forecastEtsAlpha:0.3,forecastEtsBeta:0.1,forecastEtsGamma:0.2,forecastDampedPhi:0.9,forecastMa1:0.3,forecastSeasonalityMinCorr:0.3,forecastSeasonalityMinPeriods:24,anomalySigma:2}}",
  "./financial-health": `export async function priorFiscalWindow(){return {from:'2026-01-01',to:'2026-06-30'}}
    export async function financialHealth(){const r=(n)=>Number(n).toFixed(4);return {ratios:{profitability:[],liquidity:[],solvency:[],efficiency:[],operating:[]},benchmarks:{targets:{}},figures:{
    revenue:r(300),cogs:r(120),grossProfit:r(180),opex:r(30),operatingIncome:r(150),otherIncome:r(0),otherExpense:r(0),netIncome:r(150),
    revenueGrowth:null,breakevenRevenue:null,operatingLeverage:null,rule40:null}}}`,
};
registerHooks({ resolve(specifier, context, next) {
  if (specifier in mocks) return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(mocks[specifier]!) };
  return next(specifier, context);
} });
const { healthData } = await import("./health-data");
const period = { from: "2026-04-01", to: "2026-06-30", label: "Q2" };

test("a quarterly calendar prices declared quarters labelled with period names", async () => {
  state.cadence = "quarterly";
  const result = await healthData(period, "00000000-0000-4000-8000-000000000001", null);
  assert.equal(result.monthly.length, 2);
  assert.equal(result.monthly[0]?.month, "2026-01-01");
  assert.equal(result.monthly[0]?.label, "Q1 FY2026");
  assert.equal(result.monthly[0]?.revenue, "100.0000");
  assert.equal(result.monthly[0]?.grossProfit, "60.0000");
  assert.equal(result.monthly[1]?.month, "2026-04-01");
  assert.equal(result.monthly[1]?.label, "Q2 FY2026");
  assert.equal(result.monthly[1]?.revenue, "200.0000");
  assert.equal(result.monthly[1]?.operatingIncome, "100.0000");
});

test("a monthly calendar keeps calendar months", async () => {
  state.cadence = "monthly";
  const result = await healthData(period, "00000000-0000-4000-8000-000000000001", null);
  assert.equal(result.monthly.length, 12);
  assert.equal(result.monthly[11]?.month, "2026-06");
  assert.ok((result.monthly[11]?.label ?? "").includes("26"));
});

test("a mid-period end closes the last bucket at the selected end", async () => {
  // Q2 runs to 2026-06-30 but the operator selected 2026-05-15: every date
  // bound the series sends must sit at or before the selected end, so
  // postings after it cannot leak into the trailing figures.
  state.cadence = "quarterly";
  const queries = (globalThis as unknown as { __healthFiscalQueries: FiscalQuery[] }).__healthFiscalQueries;
  queries.length = 0;
  await healthData({ from: "2026-04-01", to: "2026-05-15", label: "Q2" }, "00000000-0000-4000-8000-000000000001", null);
  const fiscal = queries.find((q) => q.sql.includes("operating_revenue") && !q.sql.includes("gl_month_activity") && !q.sql.includes("departments") && !q.sql.includes("classes") && !q.sql.includes("locations"));
  assert.ok(fiscal, "the fiscal-period series query ran");
  const bounds = (fiscal.params as unknown[]).map(String).filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p));
  assert.ok(bounds.length > 0, "the series bounds its buckets by date");
  for (const bound of bounds) assert.ok(bound <= "2026-05-15", `bucket bound ${bound} runs past the selected end`);
});
