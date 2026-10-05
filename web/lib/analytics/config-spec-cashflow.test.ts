import assert from "node:assert/strict";
import test from "node:test";
import {
  ANALYTICS_CONFIG,
  cleanConfigValues,
  mergeConfig,
} from "./config-spec";

/**
 * The Cash Flow forecast-model thresholds live in the analytics threshold
 * spec — one field per former hardcoded constant, each with today's value as
 * its default — so an organization can tune its own forecast without a code
 * change. The write path refuses out-of-range values and broken ladders by
 * name; the read path stays tolerant for legacy blobs.
 */

function fullCashflowValues(overrides: Record<string, unknown> = {}) {
  return {
    weeklyApCap: "0.0000",
    restrictToSafe: 0,
    defaultHorizonWeeks: 13,
    runwayCautionWeeks: 8,
    paymentHistoryMonths: 12,
    settleBufferSigma: 0.5,
    overduePushShortDays: 7,
    overduePushMidDays: 14,
    overduePushLongDays: 28,
    overdueMidThresholdDays: 30,
    overdueLongThresholdDays: 60,
    cardTrajectoryTolerance: 0.2,
    cardMedianBlendWeight: 0.7,
    vendorOutlierSigma: 2,
    cardStatementCloseDays: 27,
    cardDefaultPayDay: 24,
    cardStalePaymentDays: 30,
    ...overrides,
  };
}

test("cashflow spec carries every forecast-model threshold with today's default", () => {
  const spec = ANALYTICS_CONFIG.cashflow;
  assert.equal(spec.slug, "cashflow");
  assert.deepEqual(spec.defaults, fullCashflowValues());
  const keys = spec.fields.map((field) => field.key);
  for (const key of Object.keys(fullCashflowValues())) {
    assert.ok(keys.includes(key), `spec field missing for threshold '${key}'`);
  }
});

test("cashflow write accepts a full valid object and normalizes money", () => {
  const cleaned = cleanConfigValues("cashflow", fullCashflowValues({ weeklyApCap: "5000" }));
  assert.equal(cleaned.weeklyApCap, "5000.0000");
  assert.equal(cleaned.defaultHorizonWeeks, 13);
  assert.equal(cleaned.cardMedianBlendWeight, 0.7);
});

test("cashflow write refuses an out-of-range horizon by name", () => {
  assert.throws(
    () => cleanConfigValues("cashflow", fullCashflowValues({ defaultHorizonWeeks: 53 })),
    /'defaultHorizonWeeks' must be a number between 1 and 52/,
  );
  assert.throws(
    () => cleanConfigValues("cashflow", fullCashflowValues({ paymentHistoryMonths: 2 })),
    /'paymentHistoryMonths' must be a number between 3 and 36/,
  );
});

test("cashflow write refuses a broken overdue ladder by name", () => {
  assert.throws(
    () =>
      cleanConfigValues(
        "cashflow",
        fullCashflowValues({ overduePushMidDays: 28, overduePushLongDays: 14 }),
      ),
    /'overduePushLongDays' \(14\) must be greater than 'overduePushMidDays' \(28\)/,
  );
  assert.throws(
    () =>
      cleanConfigValues(
        "cashflow",
        fullCashflowValues({ overdueMidThresholdDays: 60, overdueLongThresholdDays: 60 }),
      ),
    /'overdueLongThresholdDays' \(60\) must be greater than 'overdueMidThresholdDays' \(60\)/,
  );
});

test("cashflow write refuses a fractional week count by name", () => {
  assert.throws(
    () => cleanConfigValues("cashflow", fullCashflowValues({ defaultHorizonWeeks: 13.5 })),
    /'defaultHorizonWeeks' must be a whole number/,
  );
  // The fractional knobs stay fractional: sigma multiples and blend weights
  // are coefficients, not counts.
  const cleaned = cleanConfigValues("cashflow", fullCashflowValues({ settleBufferSigma: 0.5 }));
  assert.equal(cleaned.settleBufferSigma, 0.5);
});

test("cashflow read keeps defaults for a legacy blob without the new keys", () => {
  const read = mergeConfig("cashflow", { weeklyApCap: "100.0000", restrictToSafe: 1 });
  assert.equal(read.weeklyApCap, "100.0000");
  assert.equal(read.defaultHorizonWeeks, 13);
  assert.equal(read.runwayCautionWeeks, 8);
  assert.equal(read.paymentHistoryMonths, 12);
  assert.equal(read.overduePushLongDays, 28);
  assert.equal(read.cardDefaultPayDay, 24);
});
