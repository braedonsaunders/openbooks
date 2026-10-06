import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

/**
 * The forecast-model constants ride the organization's cashflow config, and
 * the two exact-decimal combinations stay exact: the card blend's trajectory
 * share is the exact remainder of the median weight (1 - 0.7 in binary is
 * 0.30000000000000004), and the recurring-payment outlier filter measures
 * its sigma in the series' own variance (a 5x stray is excluded at 2σ).
 */
test("card blend and outlier filter stay exact while knobs ride the config", () => {
  // core.ts is server-only in production, so run the behavior check under
  // React's server condition (the same pattern used by core.test.ts). Only
  // the pure model math runs here — no database, no clock.
  const source = `
    import assert from "node:assert/strict";
    import { blendTrajectoryPayment, filterRecurringOutliers, forecastModelParams } from "./web/lib/cash/core.ts";

    // The 0.7/0.3 blend: median 70 plus trajectory 60, exactly 130 — a float
    // remainder would read 130.00000000000001 and corrupt the forecast.
    assert.equal(blendTrajectoryPayment("100.0000", "200.0000", 0.7), "130.0000");
    assert.equal(blendTrajectoryPayment("100.0000", "200.0000", 0.3), "170.0000");
    // The whole weight on one side still adds exactly.
    assert.equal(blendTrajectoryPayment("100.0000", "200.0000", 1), "100.0000");
    assert.equal(blendTrajectoryPayment("100.0000", "200.0000", 0), "200.0000");

    // A 5x stray among five regular payments is excluded at 2σ while the
    // regulars are kept — the filter measures sigma in the series' own
    // variance, so a flat series still filters.
    const regular = ["100.0000", "100.0000", "100.0000", "100.0000", "100.0000"];
    assert.deepEqual(
      filterRecurringOutliers([...regular, "500.0000"], 2),
      regular,
    );
    // A borderline value (1.7σ) is kept at 2σ but excluded at 1σ — the
    // factor discriminates instead of excluding everything either way.
    const borderline = ["100.0000", "100.0000", "100.0000", "130.0000"];
    assert.deepEqual(filterRecurringOutliers(borderline, 2), borderline);
    assert.deepEqual(filterRecurringOutliers(borderline, 1), ["100.0000", "100.0000", "100.0000"]);
    // ... and a steady series keeps everything: no false positives.
    assert.deepEqual(filterRecurringOutliers([...regular, "100.0000"], 2), [...regular, "100.0000"]);
    // Fewer than four samples cannot filter.
    assert.deepEqual(filterRecurringOutliers(["100.0000", "500.0000"], 2), ["100.0000", "500.0000"]);

    // A tuned knob wins over the spec default.
    const tuned = forecastModelParams({ cardMedianBlendWeight: 0.6 });
    assert.equal(tuned.cardMedianBlendWeight, 0.6);
    console.log("forecast model passed: exact blend, measured-sigma filter, configured knobs");
  `;
  const result = spawnSync(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", source],
    { cwd: process.cwd(), env: process.env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
