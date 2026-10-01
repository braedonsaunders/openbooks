import assert from "node:assert/strict";
import test from "node:test";
import { benefitAwardPatchBody, benefitAwardPostBody } from "./bodies";

const UUID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

const create = { action: "create", programId: UUID, employmentId: UUID, periodFrom: "2026-03-01", value: "100.0000", currency: "USD" };

test("award creation accepts an exact value and a manual source identity", () => {
  assert.equal(benefitAwardPostBody.safeParse(create).success, true);
  assert.equal(benefitAwardPostBody.safeParse({ ...create, sourceKey: "manual-march" }).success, true);
});

for (const [name, input] of [
  ["non-UUID program", { ...create, programId: "not-a-uuid" }],
  ["non-civil date", { ...create, periodFrom: "03/01/2026" }],
  ["JSON financial number", { ...create, value: 100 }],
  ["reserved settlement identity", { ...create, sourceKey: "settle:abc" }],
  ["reserved correction identity", { ...create, sourceKey: "ADJUST:abc" }],
] as const) {
  test(`award creation refuses ${name}`, () => assert.equal(benefitAwardPostBody.safeParse(input).success, false));
}

test("award lifecycle moves pin their own proof", () => {
  assert.equal(benefitAwardPatchBody.safeParse({ action: "submit" }).success, true);
  assert.equal(benefitAwardPatchBody.safeParse({ action: "approve" }).success, false);
  assert.equal(benefitAwardPatchBody.safeParse({ action: "void" }).success, false);
  assert.equal(benefitAwardPatchBody.safeParse({ action: "void", reason: "wrong period" }).success, true);
  assert.equal(
    benefitAwardPatchBody.safeParse({ action: "payrollDelivery", payrollInputId: UUID }).success,
    false,
  );
  assert.equal(
    benefitAwardPatchBody.safeParse({
      action: "payrollDelivery",
      payRunDocumentId: UUID,
      payRunAdjustmentId: UUID,
    }).success,
    true,
  );
  assert.equal(
    benefitAwardPatchBody.safeParse({ action: "externalDelivery", externalRef: "" }).success,
    false,
  );
  assert.equal(
    benefitAwardPatchBody.safeParse({ action: "externalDelivery", externalRef: "PROV-1" }).success,
    true,
  );
});

test("unknown and missing actions fail closed", () => {
  assert.equal(benefitAwardPostBody.safeParse({ programId: UUID }).success, false);
  assert.equal(benefitAwardPatchBody.safeParse({ action: "deliver" }).success, false);
  assert.equal(benefitAwardPatchBody.safeParse({}).success, false);
});

test("correction requests require a stable id, exact string amount, and reason", () => {
  const body = { action: "adjust", correctionId: UUID, value: "-10.00", reason: "Corrected hours" };
  assert.equal(benefitAwardPatchBody.safeParse(body).success, true);
  assert.equal(benefitAwardPatchBody.safeParse({ ...body, correctionId: undefined }).success, false);
  assert.equal(benefitAwardPatchBody.safeParse({ ...body, value: -10 }).success, false);
  assert.equal(benefitAwardPatchBody.safeParse({ ...body, reason: "" }).success, false);
});
