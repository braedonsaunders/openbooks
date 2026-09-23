import assert from "node:assert/strict";
import test from "node:test";
import { benefitPlanShapeProblem, normalizeHrmBenefitPlanInput } from "./hrm-benefits";

// Pure plan-body shape checks (HR-8): the drawer forces prorationBasis with
// no default, so a missing rule, an unknown basis, a non-ISO currency, and
// a negative waiting period are refused here by field name. Red-proofed:
// each case below was shown to pass with its guard reverted.
test("a plan without an explicit proration rule is refused", () => {
  assert.match(
    benefitPlanShapeProblem({ prorationBasis: null }) ?? "",
    /cannot save without it/,
  );
  assert.match(
    benefitPlanShapeProblem({ prorationBasis: "monthly" }) ?? "",
    /full_month.*daily/,
  );
});

test("unknown cost bases are refused with the vocabulary", () => {
  assert.match(
    benefitPlanShapeProblem({ prorationBasis: "daily", employeeCostBasis: "per_fortnight" }) ?? "",
    /per_period, per_month, per_year, or percent_of_pay/,
  );
  assert.match(
    benefitPlanShapeProblem({
      prorationBasis: "daily",
      employeeCostBasis: "per_month",
      employerCostBasis: "salaried",
    }) ?? "",
    /per_period, per_month, per_year, or percent_of_pay/,
  );
});

test("currency and waiting period are refused with the remedy", () => {
  const base = {
    prorationBasis: "full_month",
    employeeCostBasis: "per_month",
    employerCostBasis: "per_month",
  };
  assert.match(
    benefitPlanShapeProblem({ ...base, currency: "usd" }) ?? "",
    /3-letter ISO code in capitals/,
  );
  assert.match(
    benefitPlanShapeProblem({ ...base, waitingPeriodDays: -1 }) ?? "",
    /non-negative whole number/,
  );
  assert.match(
    benefitPlanShapeProblem({ ...base, waitingPeriodDays: 1.5 }) ?? "",
    /non-negative whole number/,
  );
});

test("the waiting-period text input creates: '30' folds, '' saves as null", () => {
  // F9: the drawer sends whole numbers as strings and blanks for the
  // optional wait. '30' must create, '' must ride absent (the writer nulls
  // it), while '1.5', '-1' and 'abc' keep the field's own refusal.
  const base = {
    prorationBasis: "full_month",
    employeeCostBasis: "per_month",
    employerCostBasis: "per_month",
  };
  assert.equal(benefitPlanShapeProblem({ ...base, waitingPeriodDays: "30" }), null);
  assert.equal(benefitPlanShapeProblem({ ...base, waitingPeriodDays: "" }), null);
  assert.equal(benefitPlanShapeProblem({ ...base }), null);
  for (const bad of ["1.5", "-1", "abc"]) {
    assert.match(
      benefitPlanShapeProblem({ ...base, waitingPeriodDays: bad }) ?? "",
      /non-negative whole number/,
      `${bad} keeps the refusal`,
    );
  }
  assert.deepEqual(normalizeHrmBenefitPlanInput("benefit-plans", { waitingPeriodDays: "30" }), { waitingPeriodDays: 30 });
  assert.deepEqual(normalizeHrmBenefitPlanInput("benefit-plans", { waitingPeriodDays: "" }), { waitingPeriodDays: null });
  assert.deepEqual(normalizeHrmBenefitPlanInput("benefit-plans", { waitingPeriodDays: "1.5" }), { waitingPeriodDays: "1.5" });
  assert.deepEqual(normalizeHrmBenefitPlanInput("other-entity", { waitingPeriodDays: "30" }), { waitingPeriodDays: "30" });
});

test("a well-shaped body passes", () => {
  assert.equal(
    benefitPlanShapeProblem({
      prorationBasis: "daily",
      employeeCostBasis: "per_period",
      employerCostBasis: "percent_of_pay",
      currency: "USD",
      waitingPeriodDays: 90,
    }),
    null,
  );
  assert.equal(benefitPlanShapeProblem({ prorationBasis: "full_month", employeeCostBasis: "per_month", employerCostBasis: "per_month" }), null);
});
