import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const state: { vendorError: unknown; spendError: unknown } = {
  vendorError: null,
  spendError: null,
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[
  Symbol.for("openbooks.vendor-metric-refusal-test")
] = state;

const modules = new Map<string, string>([
  ["mock:server-only", ""],
  ["mock:next-intl", `export async function getTranslations() { return () => '' }`],
  ["mock:money", `export function cmp(left, right) { return Number(left) - Number(right) }`],
  [
    "mock:vendor-data",
    `
    const state = globalThis[Symbol.for('openbooks.vendor-metric-refusal-test')]
    export async function vendorData(_window, _orgId, _subsidiaries) {
      if (state.vendorError) throw state.vendorError
      return {
        period: { label: 'July 2026' },
        totals: { spend: '100', hhiScaled: 500, top5SharePct: 0.5, onTimePct: 0.9, avgDaysToPay: 20, lateSpend: '0' },
        config: { hhiWarning: 1000, hhiCritical: 2000, onTimeGoodRate: 90 },
        rows: [],
      }
    }
  `,
  ],
  [
    "mock:spend-data",
    `
    const state = globalThis[Symbol.for('openbooks.vendor-metric-refusal-test')]
    export async function spendVelocityData() { if (state.spendError) throw state.spendError; throw new Error('unexpected spend data read') }
  `,
  ],
  ["mock:expense-access", `export async function reportExpenseAccess() { return {} }`],
  ["mock:fx", `export class MissingExchangeRateError extends Error {}`],
  ["mock:currency-basis", `export class ReportCurrencyBasisError extends Error {}`],
  ["mock:concentration", `export function concentrationBand() { return null }`],
  ["mock:catalog", `export function englishCatalogMessage() { return '' }`],
]);
const urls = new Map<string, string>([
  ["server-only", "mock:server-only"],
  ["next-intl/server", "mock:next-intl"],
  ["@openbooks/engine/money", "mock:money"],
  ["@/lib/analytics/vendor-data", "mock:vendor-data"],
  ["@/lib/analytics/spend-velocity-data", "mock:spend-data"],
  ["@/lib/expense-access", "mock:expense-access"],
  ["@/lib/fx-presentation", "mock:fx"],
  ["@/lib/reports/currency-basis", "mock:currency-basis"],
  ["@/lib/analytics/vendor-concentration", "mock:concentration"],
  ["@/lib/analytics/catalog-strings", "mock:catalog"],
]);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = urls.get(specifier);
    return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = modules.get(url);
    return source === undefined
      ? nextLoad(url, context)
      : { format: "module", source, shortCircuit: true };
  },
});
const metricsModuleUrl: string = "./_metrics-vendors.ts?currency-refusal-test";
type VendorMetricsModule = typeof import("./_metrics-vendors.ts");
const { loadVendorWidgetMetrics } = (await import(metricsModuleUrl)) as VendorMetricsModule;
const { MissingExchangeRateError } = await import("@/lib/fx-presentation");
const { ReportCurrencyBasisError } = await import("@/lib/reports/currency-basis");
hooks.deregister();

const ctx = {
  orgId: "org-1",
  allowedSubsidiaryIds: null,
  authz: {},
  period: async () => ({ from: "2026-07-01", to: "2026-07-31", label: "July 2026" }),
} as Parameters<typeof loadVendorWidgetMetrics>[0];

const vendorFields = new Set([
  "concentrationHhi",
  "concentrationTop5Share",
  "concentrationBand",
  "vendorOnTimeRate",
  "vendorOnTimeGoodRate",
  "vendorAvgDaysToPay",
  "vendorLateSpend",
  "vendorUnratedCount",
  "vendorPeriodLabel",
]);
const spendFields = new Set(["spendOpenAlerts", "spendSavingsPotential", "vendorPeriodLabel"]);

const refusals = [
  {
    name: MissingExchangeRateError.name,
    create: () => new MissingExchangeRateError("USD", "CAD", "2026-07-01"),
  },
  {
    name: ReportCurrencyBasisError.name,
    create: () => new ReportCurrencyBasisError(),
  },
] as const;

for (const refusal of refusals) {
  test(`vendor widgets report ${refusal.name} as unavailable`, async () => {
    const error = refusal.create();
    state.vendorError = error;
    state.spendError = null;
    const metrics = await loadVendorWidgetMetrics(ctx, (...fields) =>
      fields.some((field) => vendorFields.has(field)),
    );
    assert.deepEqual(metrics.concentrationHhi, { available: false, reason: error.message });
    assert.deepEqual(metrics.vendorOnTimeRate, { available: false, reason: error.message });
    assert.equal(metrics.concentrationBand, null);
    assert.equal(metrics.vendorPeriodLabel, "July 2026");
  });

  test(`spend widgets report ${refusal.name} as unavailable`, async () => {
    const error = refusal.create();
    state.vendorError = null;
    state.spendError = error;
    const metrics = await loadVendorWidgetMetrics(ctx, (...fields) =>
      fields.some((field) => spendFields.has(field)),
    );
    assert.deepEqual(metrics.spendOpenAlerts, { available: false, reason: error.message });
    assert.deepEqual(metrics.spendSavingsPotential, { available: false, reason: error.message });
    assert.equal(metrics.vendorPeriodLabel, "July 2026");
  });
}

test("vendor widgets continue to propagate unexpected failures", async () => {
  const error = new Error("unexpected failure");
  state.vendorError = error;
  state.spendError = null;
  await assert.rejects(
    loadVendorWidgetMetrics(ctx, (...fields) => fields.some((field) => vendorFields.has(field))),
    (actual) => actual === error,
  );
});
