import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const state = { otherIncome: 0 };
Object.assign(globalThis, { __healthMarginFlow: state });
const mocks: Record<string, string> = {
  "server-only": "export {}",
  "@openbooks/engine/src/platform/db.ts": "export function ambientTenantOrgId(){return null} export function registerRequestOrgResolver(){} export async function withBypassContext(work){return work()} export const db={async execute(){return {rows:[]}}}",
  "../money-server": "export async function getMoneyFormatter(){return {money:String,moneyCompact:String}}",
  "../features": "export async function isFeatureEnabled(){return false}",
  "./config": "export async function analyticsConfig(){return {insightCriticalPercent:50,insightWarningPercent:75,revenueDeclineAlertPercent:15,revenueTrendAlertPercent:10,marginCompressionPoints:3,breakevenSafetyPercent:10,breakevenComfortPercent:30,budgetOnTrackPercent:10,budgetWatchPercent:25,segmentHhiWarning:1500,segmentHhiCritical:2500,operatingMarginTarget:15,anomalySigma:2}}",
  "./financial-health": `export async function priorFiscalWindow(){return {from:'2025-07-01',to:'2025-07-31'}}
    export async function financialHealth(){const r=(n)=>Number(n).toFixed(4);return {ratios:{profitability:[],liquidity:[],solvency:[],efficiency:[],operating:[]},benchmarks:{targets:{}},figures:{
    revenue:r(100+globalThis.__healthMarginFlow.otherIncome),cogs:r(20),grossProfit:r(80+globalThis.__healthMarginFlow.otherIncome),opex:r(30),operatingIncome:r(50),otherIncome:r(globalThis.__healthMarginFlow.otherIncome),otherExpense:r(5),netIncome:r(45+globalThis.__healthMarginFlow.otherIncome),
    revenueGrowth:null,breakevenRevenue:null,operatingLeverage:null,rule40:null}}}`,
};
registerHooks({ resolve(specifier, context, next) {
  if (specifier in mocks) return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(mocks[specifier]!) };
  return next(specifier, context);
} });
const { healthData } = await import("./health-data");
const { add } = await import("@openbooks/engine/src/money/money.ts");
const period = { from: "2026-07-01", to: "2026-07-31", label: "July" };
for (const otherIncome of [50, -10, 0]) {
  test(`margin waterfall reconciles every subtotal with other income ${otherIncome}`, async () => {
    state.otherIncome = otherIncome;
    const result = await healthData(period, "00000000-0000-4000-8000-000000000001", null);
    let running = "0";
    for (const stage of result.marginFlow) {
      if (stage.kind === "start") running = stage.amount;
      else if (stage.kind === "deduct") running = add(running, stage.amount);
      else assert.equal(stage.amount, running, `${stage.label} must reconcile to the preceding steps`);
      assert.match(stage.pctOfRevenue ?? "", /^-?\d+\.\d{4}$/, "a share of positive revenue is an exact fraction");
    }
    assert.equal(running, (45 + otherIncome).toFixed(4));
  });
}
