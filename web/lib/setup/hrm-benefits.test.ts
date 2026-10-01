import assert from "node:assert/strict";
import test from "node:test";
import { benefitPlanShapeProblem, normalizeHrmBenefitPlanInput } from "./hrm-benefits";

const monthly = { prorationBasis: "full_month", employeeCostBasis: "per_month", employerCostBasis: "per_month" };

for (const { name, body, refusal } of [
  { name: "a plan needs an explicit proration rule", body: { prorationBasis: null }, refusal: /cannot save without it/ },
  { name: "proration uses the supported vocabulary", body: { prorationBasis: "monthly" }, refusal: /full_month.*daily/ },
  { name: "employee cost bases use the supported vocabulary", body: { prorationBasis: "daily", employeeCostBasis: "per_fortnight" }, refusal: /per_period, per_month, per_year, or percent_of_pay/ },
  { name: "employer cost bases use the supported vocabulary", body: { prorationBasis: "daily", employeeCostBasis: "per_month", employerCostBasis: "salaried" }, refusal: /per_period, per_month, per_year, or percent_of_pay/ },
  { name: "currency names its ISO remedy", body: { ...monthly, currency: "usd" }, refusal: /3-letter ISO code in capitals/ },
  { name: "waiting periods cannot be negative", body: { ...monthly, waitingPeriodDays: -1 }, refusal: /non-negative whole number/ },
  { name: "waiting periods cannot be fractional", body: { ...monthly, waitingPeriodDays: 1.5 }, refusal: /non-negative whole number/ },
]) {
  test(name, () => assert.match(benefitPlanShapeProblem(body) ?? "", refusal));
}

test("waiting-period text input preserves exact whole numbers and names malformed values", () => {
  for (const waitingPeriodDays of ["30", "", undefined]) assert.equal(benefitPlanShapeProblem({ ...monthly, waitingPeriodDays }), null);
  for (const waitingPeriodDays of ["1.5", "-1", "abc"]) {
    assert.match(benefitPlanShapeProblem({ ...monthly, waitingPeriodDays }) ?? "", /non-negative whole number/, waitingPeriodDays);
  }
  for (const [input, normalized] of [["30", 30], ["", null], ["1.5", "1.5"]]) {
    assert.deepEqual(normalizeHrmBenefitPlanInput("benefit-plans", { waitingPeriodDays: input }), { waitingPeriodDays: normalized });
  }
  assert.deepEqual(normalizeHrmBenefitPlanInput("other-entity", { waitingPeriodDays: "30" }), { waitingPeriodDays: "30" });
});

test("valid daily and monthly plan bodies pass", () => {
  assert.equal(benefitPlanShapeProblem({ prorationBasis: "daily", employeeCostBasis: "per_period", employerCostBasis: "percent_of_pay", currency: "USD", waitingPeriodDays: 90 }), null);
  assert.equal(benefitPlanShapeProblem(monthly), null);
});
