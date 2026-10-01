import assert from "node:assert/strict";
import test from "node:test";
import { benefitAwardPatchBody, benefitAwardPostBody } from "./bodies";

const UUID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

// Pure boundary checks: real zod parses — civil dates, unknown and missing
// actions, reserved settlement keys, and decimal strings. No mocks: the
// schemas are pure validation, so the tests run them directly.
test("award create pins program, employment, period, and exact decimal value", () => {
  const parsed = benefitAwardPostBody.safeParse({
    action: "create",
    programId: UUID,
    employmentId: UUID,
    periodFrom: "2026-03-01",
    value: "100.0000",
    currency: "USD",
  });
  assert.equal(parsed.success, true);
});

test("award create refuses bad dates and non-uuid subjects", () => {
  assert.equal(
    benefitAwardPostBody.safeParse({
      action: "create",
      programId: "not-a-uuid",
      employmentId: UUID,
      periodFrom: "2026-03-01",
      value: "100.0000",
      currency: "USD",
    }).success,
    false,
  );
  assert.equal(
    benefitAwardPostBody.safeParse({
      action: "create",
      programId: UUID,
      employmentId: UUID,
      periodFrom: "03/01/2026",
      value: "100.0000",
      currency: "USD",
    }).success,
    false,
  );
});

test("award create refuses JSON numbers and reserved settlement keys", () => {
  assert.equal(
    benefitAwardPostBody.safeParse({
      action: "create",
      programId: UUID,
      employmentId: UUID,
      periodFrom: "2026-03-01",
      value: 100,
      currency: "USD",
    }).success,
    false,
  );
  for (const key of ["settle:abc", "ADJUST:abc"]) {
    const parsed = benefitAwardPostBody.safeParse({
      action: "create",
      programId: UUID,
      employmentId: UUID,
      periodFrom: "2026-03-01",
      value: "100.0000",
      currency: "USD",
      sourceKey: key,
    });
    assert.equal(parsed.success, false);
  }
  assert.equal(
    benefitAwardPostBody.safeParse({
      action: "create",
      programId: UUID,
      employmentId: UUID,
      periodFrom: "2026-03-01",
      value: "100.0000",
      currency: "USD",
      sourceKey: "manual-march",
    }).success,
    true,
  );
});

test("award lifecycle moves pin their own proof", () => {
  assert.equal(benefitAwardPatchBody.safeParse({ action: "submit" }).success, true);
  assert.equal(benefitAwardPatchBody.safeParse({ action: "approve" }).success, true);
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
