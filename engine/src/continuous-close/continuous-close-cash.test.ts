import test from "node:test";
import assert from "node:assert/strict";
import { normalizeContinuousCloseDetectors } from "../agents/continuous-close-config.ts";

/* Pack membership is asserted once in agents/registry.test.ts
 * (assertPackRegistersEnabledDetectors); detector correctness — starting
 * cash, cross-currency netting ("the crunch nets a foreign credit through
 * its source leg", materiality 21.0000 not 19), reimbursement payables
 * ("the crunch sees reimbursement payables on the employee-payable
 * control"), statistical prediction weeks, and fingerprint stability — is
 * proven through the real pack in
 * continuous-close-cash.integration.test.ts. The remaining source-text
 * pins below asserted implementation choices (which lateral, which helper,
 * no duplicated literal): no black-box behaviour distinguishes them, so
 * they are deleted. Timeline knob wiring is replaced by "a binding weekly
 * AP cap silences the shortfall it would otherwise fire" in the same
 * integration file. */

test("cash detector parameter validation still refuses a zero forecast window", () => {
  assert.throws(
    () =>
      normalizeContinuousCloseDetectors("cash", {
        cash_forecast_shortfall: { parameters: { forecastWeeks: 0 } },
      }),
    /invalid detector parameter/,
  );
});
