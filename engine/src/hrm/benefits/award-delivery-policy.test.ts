import assert from "node:assert/strict";
import test from "node:test";
import { awardDeliveryPolicy } from "./award-delivery-policy.ts";

const entity = "11111111-1111-4111-8111-111111111111";
const component = "22222222-2222-4222-8222-222222222222";
test("retained delivery policy preserves issuance terms independently of later programme changes", () => {
  const program = {
    code: "ORIGINAL",
    legalEntityId: entity,
    paymentDelayDays: 0,
    deliveryMethod: "payroll",
    revision: 3,
  };
  const source = { payComponentId: component, measurement: { periodFrom: "2026-07-01" } };
  const bytes = JSON.stringify({ program, source });
  const retained = awardDeliveryPolicy(program, source);
  const later = { ...program, code: "LATER", paymentDelayDays: 30, deliveryMethod: "external" };
  assert.notDeepEqual(retained, later);
  assert.deepEqual(retained, {
    code: "ORIGINAL",
    legalEntityId: entity,
    paymentDelayDays: 0,
    deliveryMethod: "payroll",
    payComponentId: component,
  });
  assert.equal(JSON.stringify({ program, source }), bytes);
});
test("unknown issuance terms refuse instead of adopting current configuration", () => {
  const program = {
    code: "ORIGINAL",
    legalEntityId: entity,
    paymentDelayDays: 0,
    deliveryMethod: "payroll",
  };
  for (const field of ["code", "legalEntityId", "paymentDelayDays", "deliveryMethod"]) {
    const missing: Record<string, unknown> = { ...program };
    delete missing[field];
    assert.throws(
      () => awardDeliveryPolicy(missing, { payComponentId: component }),
      /missing original delivery terms/,
    );
  }
  for (const source of [{}, null, { payComponentId: "unknown" }])
    assert.throws(
      () => awardDeliveryPolicy(program, source),
      /retained delivery policy|missing original delivery terms/,
    );
  for (const delay of [-1, 0.5, "0", NaN, Infinity])
    assert.throws(
      () =>
        awardDeliveryPolicy({ ...program, paymentDelayDays: delay }, { payComponentId: component }),
      /missing original delivery terms/,
    );
});
