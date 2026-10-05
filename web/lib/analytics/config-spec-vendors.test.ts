import assert from "node:assert/strict";
import test from "node:test";

const { ANALYTICS_CONFIG, cleanConfigValues, isAnalyticsDashboard, mergeConfig } = await import("./config-spec.ts");

/**
 * The vendor/span threshold specs: every hardcoded Vendor Performance and
 * Spend Velocity assumption lives in config-spec with an editable default,
 * and the write path refuses inverted ladders and non-money by name.
 */

test("vendorPerformance is a registered dashboard on the vendor-performance slug", () => {
  assert.equal(isAnalyticsDashboard("vendorPerformance"), true);
  assert.equal(ANALYTICS_CONFIG.vendorPerformance.slug, "vendor-performance");
});

test("every dashboard's defaults satisfy its own ordered ladders", () => {
  for (const [name, spec] of Object.entries(ANALYTICS_CONFIG)) {
    for (const ladder of spec.ordered ?? []) {
      for (let i = 1; i < ladder.length; i++) {
        const low = spec.defaults[ladder[i - 1]!];
        const high = spec.defaults[ladder[i]!];
        assert.ok(
          Number(high) > Number(low),
          `${name}: default ${ladder[i]} (${high}) must exceed ${ladder[i - 1]} (${low})`,
        );
      }
    }
  }
});

test("spendVelocity money thresholds are optional and unset by default", () => {
  assert.equal(ANALYTICS_CONFIG.spendVelocity.defaults.minBaseAmount, "");
  assert.equal(ANALYTICS_CONFIG.spendVelocity.defaults.fragmentationMaxAvgSize, "");
});

function fullSpend(values: Record<string, number | string>): Record<string, number | string> {
  return { ...ANALYTICS_CONFIG.spendVelocity.defaults, ...values };
}

test("an inverted HHI ladder is refused by name", () => {
  assert.throws(
    () => cleanConfigValues("spendVelocity", fullSpend({ hhiWarning: 2500, hhiCritical: 2500 })),
    (e: unknown) => e instanceof Error && /'hhiCritical'/.test(e.message),
  );
});

test("an inverted vendor grade ladder is refused by name", () => {
  const values = { ...ANALYTICS_CONFIG.vendorPerformance.defaults, gradeB: 90 };
  assert.throws(
    () => cleanConfigValues("vendorPerformance", values),
    (e: unknown) => e instanceof Error && /'gradeB'/.test(e.message),
  );
});

test("an empty optional money threshold saves as unset", () => {
  const out = cleanConfigValues("spendVelocity", fullSpend({ minBaseAmount: "" }));
  assert.equal(out.minBaseAmount, "");
});

test("a negative money threshold is refused by name", () => {
  assert.throws(
    () => cleanConfigValues("spendVelocity", fullSpend({ minBaseAmount: "-5" })),
    (e: unknown) => e instanceof Error && /'minBaseAmount'/.test(e.message),
  );
});

test("an unknown key is refused by name", () => {
  assert.throws(
    () => cleanConfigValues("vendorPerformance", { ...ANALYTICS_CONFIG.vendorPerformance.defaults, bogus: 1 }),
    (e: unknown) => e instanceof Error && /'bogus'/.test(e.message),
  );
});

test("a money threshold saved in another currency reads as unset", () => {
  const merged = mergeConfig(
    "spendVelocity",
    { ...ANALYTICS_CONFIG.spendVelocity.defaults, minBaseAmount: "100.0000" },
    { stored: "EUR", presentation: "USD" },
  );
  assert.equal(merged.minBaseAmount, "");
});
