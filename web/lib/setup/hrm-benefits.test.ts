import assert from "node:assert/strict";
import test from "node:test";
import { benefitPlanShapeProblem, normalizeHrmBenefitPlanInput } from "./hrm-benefits";

const monthly = { currency: "CAD" };

for (const { name, body, refusal } of [
  { name: "retired two-side pricing is refused with its native replacement", body: { employeeCost: "25" }, refusal: /Configure pricing in Contributions/ },
  { name: "calendar-month waiting period cannot also count days", body: { waitingPeriodDays: 30, waitingPeriodMonths: 3 }, refusal: /months or days, not both/ },
  { name: "calendar-month waiting period cannot be fractional", body: { waitingPeriodMonths: "1.5" }, refusal: /whole number of calendar months/ },
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
  for (const field of ["waitingPeriodDays", "waitingPeriodMonths"]) for (const [input, normalized] of [["30", 30], ["", 0], ["1.5", "1.5"]]) {
    assert.deepEqual(normalizeHrmBenefitPlanInput("benefit-plans", { [field]: input }), { [field]: normalized });
  }
  assert.deepEqual(normalizeHrmBenefitPlanInput("other-entity", { waitingPeriodDays: "30" }), { waitingPeriodDays: "30" });
});

test("offer identity and explicit waiting periods pass without retired pricing fields", () => {
  assert.equal(benefitPlanShapeProblem({ currency: "USD", waitingPeriodDays: 90 }), null);
  assert.equal(benefitPlanShapeProblem(monthly), null);
});
