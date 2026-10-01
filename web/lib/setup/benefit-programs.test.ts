import assert from "node:assert/strict";
import test from "node:test";
import { benefitProgramShapeProblem } from "./benefit-programs";

const reward = { family: "reward", currency: "USD", frequency: "manual" };
const quarterly = { ...reward, family: "incentive", frequency: "quarterly" };
for (const { name, body, refusal } of [
  { name: "unknown program families name the available choices", body: { ...reward, family: "health" }, refusal: /reward, allowance, incentive, or custom/ },
  { name: "program currency requires an uppercase ISO code", body: { ...reward, currency: "usd" }, refusal: /3-letter ISO code in capitals/ },
  { name: "quarterly programs need an explicit period basis", body: quarterly, refusal: /calendar or fiscal/ },
  { name: "annual programs refuse an unknown period basis", body: { ...quarterly, frequency: "annual", periodBasis: "lunar" }, refusal: /calendar or fiscal/ },
]) {
  test(name, () => assert.match(benefitProgramShapeProblem(body) ?? "", refusal));
}
test("manual rewards and explicitly fiscal quarterly programs pass", () => {
  assert.equal(benefitProgramShapeProblem({ ...quarterly, periodBasis: "fiscal" }), null);
  assert.equal(benefitProgramShapeProblem(reward), null);
});
