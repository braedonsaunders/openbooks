import test from "node:test";
import assert from "node:assert/strict";
import { normalizeContinuousCloseDetectors } from "../agents/continuous-close-config.ts";

/* Pack membership is asserted once in agents/registry.test.ts; detector
 * correctness is proven through the real pack in
 * continuous-close-payroll.integration.test.ts ("a committed run produces
 * dated remittance findings and no unknown-account noise", "missing
 * elections and missing SINs surface per country and clear on file", and "a
 * month the remittance summary cannot evaluate surfaces an explicit gap").
 * The deleted source-text pins asserted implementation reuse, which no
 * black-box behaviour distinguishes. */

test("payroll detector parameter validation still refuses a zero due window", () => {
  assert.throws(
    () =>
      normalizeContinuousCloseDetectors("payroll", {
        payroll_remittance_due: { parameters: { dueWithinDays: 0 } },
      }),
    /invalid detector parameter/,
  );
});

