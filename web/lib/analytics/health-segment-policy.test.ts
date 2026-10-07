import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Segment health and adjustment factors read organization configuration,
// never fixed cut-offs. The loader is DB-backed, so these pin the pure
// grading and derivation behind it with the same stub surface the other
// health-data unit tests use — no database, no template.

const mocks: Record<string, string> = {
  "server-only": "export {}",
  "@openbooks/engine/src/platform/db.ts": `export function ambientTenantOrgId(){return null} export function registerRequestOrgResolver(){} export async function withBypassContext(work){return work()} export const db={async execute(){return {rows:[]}}}`,
  "../money-server": "export async function getMoneyFormatter(){return {money:String,moneyCompact:String}}",
  "../features": "export async function isFeatureEnabled(){return true}",
  "./config": "export async function analyticsConfig(){return {}}",
  "./financial-health": "export async function priorFiscalWindow(){return {from:'2025-07-01',to:'2025-07-31'}} export async function financialHealth(){return {ratios:{},benchmarks:{targets:{}},figures:{}}}",
};
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "./config" && !context.parentURL?.startsWith(new URL("./", import.meta.url).href)) return next(specifier, context);
  if (specifier in mocks) return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(mocks[specifier]!) };
  return next(specifier, context);
} });
const { forecastAdjustmentValue, gradeSegmentHealth } = await import("./health-data");
const { ANALYTICS_CONFIG } = await import("./config-spec");

test("segment health grades against the configured target, never a fixed cut-off", () => {
  // A 20% target with a 50% warning share: 20% itself is good, 15% is warn,
  // 9% is bad. A hardcoded 15% target would read 0.15 as good.
  const policy = { target: "0.2000", warningShare: "0.5000" };
  assert.equal(gradeSegmentHealth("0.2000", policy), "good");
  assert.equal(gradeSegmentHealth("0.1500", policy), "warn");
  assert.equal(gradeSegmentHealth("0.1000", policy), "warn");
  assert.equal(gradeSegmentHealth("0.0900", policy), "bad");
  // Without revenue there is no margin to grade: no dot, never a stand-in.
  assert.equal(gradeSegmentHealth(null, policy), null);
});

test("every configured adjustment option prices from the single adjustment table", () => {
  const fields = new Map(ANALYTICS_CONFIG.financialHealth.fields.map((f) => [f.key, f]));
  const options = fields.get("forecastAdjustment")?.options ?? [];
  assert.deepEqual([...options].sort(), ["neg05", "neg10", "pos05", "pos10", "zero"]);
  const priced = Object.fromEntries(options.map((code) => [code, forecastAdjustmentValue(code)]));
  assert.deepEqual(priced, { neg10: -0.1, neg05: -0.05, zero: 0, pos05: 0.05, pos10: 0.1 });
  // A code outside the table fails loudly by name, never a silent band.
  assert.throws(() => forecastAdjustmentValue("turbo"), /unknown forecast adjustment code "turbo"/);
});
