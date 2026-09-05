import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const state = { otherIncome: 0 };
Object.assign(globalThis, { __healthMarginFlow: state });
const mocks: Record<string, string> = {
  "server-only": "export {}",
  "@openbooks/engine/src/db.ts": "export async function withBypassContext(work){return work()} export const db={async execute(){return {rows:[]}}}",
  "../money-server": "export async function getMoneyFormatter(){return {money:String,moneyCompact:String}}",
  "../features": "export async function isFeatureEnabled(){return false}",
  "./financial-health": `export async function financialHealth(){return {figures:{
    revenue:100+globalThis.__healthMarginFlow.otherIncome,cogs:20,grossProfit:80+globalThis.__healthMarginFlow.otherIncome,opex:30,operatingIncome:50,otherIncome:globalThis.__healthMarginFlow.otherIncome,otherExpense:5,netIncome:45+globalThis.__healthMarginFlow.otherIncome,
    revenueGrowth:0,breakevenMonthly:null,operatingLeverage:0,rule40:0}}}`,
};
registerHooks({ resolve(specifier, context, next) {
  if (specifier in mocks) return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(mocks[specifier]!) };
  return next(specifier, context);
} });
const { healthData } = await import("./health-data");
const period = { from: "2026-07-01", to: "2026-07-31", label: "July" };
for (const otherIncome of [50, -10, 0]) {
  test(`margin waterfall reconciles every subtotal with other income ${otherIncome}`, async () => {
    state.otherIncome = otherIncome;
    const result = await healthData(period, "00000000-0000-4000-8000-000000000001", null);
    let running = 0;
    for (const stage of result.marginFlow) {
      if (stage.kind === "start") running = stage.amount;
      else if (stage.kind === "deduct") running += stage.amount;
      else assert.equal(stage.amount, running, `${stage.label} must reconcile to the preceding steps`);
      assert.ok(Number.isFinite(stage.pctOfRevenue));
    }
    assert.equal(running, 45 + otherIncome);
  });
}
