import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

/**
 * The forecast-model constants ride the organization's cashflow config, and
 * the two exact-decimal combinations stay exact: the card blend's trajectory
 * share is the exact remainder of the median weight (1 - 0.7 in binary is
 * 0.30000000000000004), and the outlier filter squares its sigma multiple in
 * decimal (2σ filters at 4, never a float product).
 */
test("card blend and outlier factor stay exact while knobs ride the config", () => {
  // core.ts is server-only in production, so run the behavior check under
  // React's server condition (the same pattern used by core.test.ts). Only
  // the pure model math runs here — no database, no clock.
  const source = `
    import assert from "node:assert/strict";
    import { blendTrajectoryPayment, forecastModelParams, outlierVarianceFactor } from "./web/lib/cash/core.ts";

    // The 0.7/0.3 blend: median 70 plus trajectory 60, exactly 130 — a float
    // remainder would read 130.00000000000001 and corrupt the forecast.
    assert.equal(blendTrajectoryPayment("100.0000", "200.0000", 0.7), "130.0000");
    assert.equal(blendTrajectoryPayment("100.0000", "200.0000", 0.3), "170.0000");
    // The whole weight on one side still adds exactly.
    assert.equal(blendTrajectoryPayment("100.0000", "200.0000", 1), "100.0000");
    assert.equal(blendTrajectoryPayment("100.0000", "200.0000", 0), "200.0000");

    // The 2σ outlier filter squares to 4; a fractional sigma stays exact.
    assert.equal(outlierVarianceFactor(2), "4");
    assert.equal(outlierVarianceFactor(1.5), "2.25");

    // Unresolved knobs fall back to today's values, the spec defaults.
    assert.deepEqual(forecastModelParams({}), {
      settleBufferSigma: 0.5,
      overduePushShortDays: 7, overduePushMidDays: 14, overduePushLongDays: 28,
      overdueMidThresholdDays: 30, overdueLongThresholdDays: 60,
      cardTrajectoryTolerance: 0.2, cardMedianBlendWeight: 0.7, vendorOutlierSigma: 2,
      cardStatementCloseDays: 27, cardDefaultPayDay: 24, cardStalePaymentDays: 30,
    });
    // A tuned knob wins; an explicit undefined still falls back.
    const tuned = forecastModelParams({ cardMedianBlendWeight: 0.6, cardDefaultPayDay: undefined });
    assert.equal(tuned.cardMedianBlendWeight, 0.6);
    assert.equal(tuned.cardDefaultPayDay, 24);
    console.log("forecast model passed: exact blend, exact sigma square, configured knobs");
  `;
  const result = spawnSync(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", source],
    { cwd: process.cwd(), env: process.env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
