import assert from "node:assert/strict";
import test from "node:test";
import { benefitProgramShapeProblem } from "./benefit-programs";

// Pure program-body shape checks: unknown family, non-ISO currency, and a
// quarterly or annual program without a calendar or fiscal period basis are
// refused here by field name. Red-proofed: each case was shown to fail with
// its guard reverted.
test("unknown families and non-ISO currency are refused", () => {
  assert.match(
    benefitProgramShapeProblem({ family: "health", currency: "USD", frequency: "manual" }) ?? "",
    /reward, allowance, incentive, or custom/,
  );
  assert.match(
    benefitProgramShapeProblem({ family: "reward", currency: "usd", frequency: "manual" }) ?? "",
    /3-letter ISO code in capitals/,
  );
});

test("quarterly and annual programs name calendar or fiscal periods", () => {
  assert.match(
    benefitProgramShapeProblem({ family: "incentive", currency: "USD", frequency: "quarterly" }) ?? "",
    /calendar or fiscal/,
  );
  assert.match(
    benefitProgramShapeProblem({
      family: "incentive",
      currency: "USD",
      frequency: "annual",
      periodBasis: "lunar",
    }) ?? "",
    /calendar or fiscal/,
  );
  assert.equal(
    benefitProgramShapeProblem({
      family: "incentive",
      currency: "USD",
      frequency: "quarterly",
      periodBasis: "fiscal",
    }),
    null,
  );
  assert.equal(
    benefitProgramShapeProblem({ family: "reward", currency: "USD", frequency: "manual" }),
    null,
  );
});
