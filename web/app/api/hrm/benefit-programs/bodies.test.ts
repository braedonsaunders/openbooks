import assert from "node:assert/strict";
import test from "node:test";
import { benefitProgramPatchBody, benefitProgramPostBody } from "./bodies";

const UUID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

// Pure boundary checks: real zod parses — civil dates, families, decimal
// strings, reasons, and unknown or missing actions. No mocks: the schemas
// are pure validation, so the tests run them directly.
test("program create pins family, currency, dates, and decimal strings", () => {
  const parsed = benefitProgramPostBody.safeParse({
    action: "create",
    code: "SPOT",
    name: "Spot bonus",
    family: "reward",
    currency: "USD",
    effectiveFrom: "2026-01-01",
    fixedAmount: "100.0000",
  });
  assert.equal(parsed.success, true);
});

test("program create refuses bad family, currency, dates, and JSON numbers", () => {
  const base = {
    action: "create",
    code: "SPOT",
    name: "Spot bonus",
    family: "reward",
    currency: "USD",
    effectiveFrom: "2026-01-01",
  };
  assert.equal(benefitProgramPostBody.safeParse({ ...base, family: "health" }).success, false);
  assert.equal(benefitProgramPostBody.safeParse({ ...base, currency: "usd" }).success, false);
  assert.equal(benefitProgramPostBody.safeParse({ ...base, effectiveFrom: "01/01/2026" }).success, false);
  assert.equal(
    benefitProgramPostBody.safeParse({ ...base, fixedAmount: 100 }).success,
    false,
  );
  assert.equal(benefitProgramPostBody.safeParse({ ...base, code: "" }).success, false);
});

test("close and membership moves require their reason and subject", () => {
  assert.equal(benefitProgramPatchBody.safeParse({ action: "close" }).success, false);
  assert.equal(
    benefitProgramPatchBody.safeParse({ action: "close", reason: "year ended" }).success,
    true,
  );
  assert.equal(benefitProgramPostBody.safeParse({ action: "activate" }).success, true);
  assert.equal(
    benefitProgramPostBody.safeParse({ action: "addMember", employmentId: UUID }).success,
    false,
  );
  assert.equal(
    benefitProgramPostBody.safeParse({
      action: "addMember",
      employmentId: UUID,
      effectiveFrom: "2026-01-01",
    }).success,
    true,
  );
  assert.equal(
    benefitProgramPostBody.safeParse({ action: "removeMember", membershipId: UUID }).success,
    false,
  );
});

test("unknown and missing actions fail closed", () => {
  assert.equal(benefitProgramPostBody.safeParse({ code: "SPOT" }).success, false);
  assert.equal(benefitProgramPatchBody.safeParse({ action: "settle" }).success, false);
  assert.equal(benefitProgramPatchBody.safeParse({}).success, false);
});

test("draft source replacement survives the boundary and rejects foreign-shaped ids", () => {
  const body = { action: "update", sourceAccountIds: [UUID], reason: "Revised measure" };
  const parsed = benefitProgramPatchBody.parse(body);
  assert.equal(parsed.action, "update");
  if (parsed.action === "update") assert.deepEqual(parsed.sourceAccountIds, [UUID]);
  assert.equal(benefitProgramPatchBody.safeParse({ ...body, sourceAccountIds: ["not-an-id"] }).success, false);
});
