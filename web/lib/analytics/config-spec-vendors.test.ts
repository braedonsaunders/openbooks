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
    const ladders: readonly (readonly string[])[] = "ordered" in spec && spec.ordered ? spec.ordered : [];
    const defaults: Record<string, number | string> = spec.defaults;
    for (const ladder of ladders) {
      for (let i = 1; i < ladder.length; i++) {
        const low = defaults[ladder[i - 1]!];
        const high = defaults[ladder[i]!];
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

test("broken thresholds are refused by name", () => {
  const cases: Array<{ name: string; dashboard: "spendVelocity" | "vendorPerformance"; values: Record<string, number | string>; key: string }> = [
    { name: "inverted HHI ladder", dashboard: "spendVelocity", values: fullSpend({ hhiWarning: 2500, hhiCritical: 2500 }), key: "hhiCritical" },
    { name: "inverted vendor grade ladder", dashboard: "vendorPerformance", values: { ...ANALYTICS_CONFIG.vendorPerformance.defaults, gradeB: 90 }, key: "gradeB" },
    { name: "negative money threshold", dashboard: "spendVelocity", values: fullSpend({ minBaseAmount: "-5" }), key: "minBaseAmount" },
    { name: "unknown key", dashboard: "vendorPerformance", values: { ...ANALYTICS_CONFIG.vendorPerformance.defaults, bogus: 1 }, key: "bogus" },
  ];
  for (const c of cases) {
    const key = c.key;
    assert.throws(
      () => cleanConfigValues(c.dashboard, c.values),
      (e: unknown) => e instanceof Error && new RegExp(`'${key}'`).test(e.message),
      c.name,
    );
  }
});

test("an empty optional money threshold saves as unset", () => {
  const out = cleanConfigValues("spendVelocity", fullSpend({ minBaseAmount: "" }));
  assert.equal(out.minBaseAmount, "");
});

test("a money threshold saved in another currency reads as unset", () => {
  const merged = mergeConfig(
    "spendVelocity",
    { ...ANALYTICS_CONFIG.spendVelocity.defaults, minBaseAmount: "100.0000" },
    { stored: "EUR", presentation: "USD" },
  );
  assert.equal(merged.minBaseAmount, "");
});
