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
  assert.equal(
    benefitProgramPostBody.safeParse({ ...base, effectiveFrom: "01/01/2026" }).success,
    false,
  );
  assert.equal(benefitProgramPostBody.safeParse({ ...base, fixedAmount: 100 }).success, false);
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
    benefitProgramPostBody.safeParse({
      action: "addMember",
      employmentId: UUID,
    }).success,
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
    benefitProgramPostBody.safeParse({
      action: "removeMember",
      membershipId: UUID,
    }).success,
    false,
  );
});

test("unknown and missing actions fail closed", () => {
  assert.equal(benefitProgramPostBody.safeParse({ code: "SPOT" }).success, false);
  assert.equal(benefitProgramPatchBody.safeParse({ action: "settle" }).success, false);
  assert.equal(benefitProgramPatchBody.safeParse({}).success, false);
});

test("draft source replacement survives the boundary and rejects foreign-shaped ids", () => {
  const body = {
    action: "update",
    sourceAccountIds: [UUID],
    reason: "Revised measure",
  };
  const parsed = benefitProgramPatchBody.parse(body);
  assert.equal(parsed.action, "update");
  if (parsed.action === "update") assert.deepEqual(parsed.sourceAccountIds, [UUID]);
  assert.equal(
    benefitProgramPatchBody.safeParse({
      ...body,
      sourceAccountIds: ["not-an-id"],
    }).success,
    false,
  );
});

test("an active revision carries an optional civil apply-from date and still requires its reason", () => {
  const parsed = benefitProgramPatchBody.parse({
    action: "update",
    fixedAmount: "150.00",
    reason: "Rate review",
    changeEffectiveFrom: "2026-10-11",
  });
  assert.equal(parsed.action, "update");
  if (parsed.action === "update") assert.equal(parsed.changeEffectiveFrom, "2026-10-11");
  const draft = benefitProgramPatchBody.parse({
    action: "update",
    reason: "Draft fix",
  });
  if (draft.action === "update") assert.equal(draft.changeEffectiveFrom, undefined);
  assert.equal(
    benefitProgramPatchBody.safeParse({
      action: "update",
      reason: "Rate review",
      changeEffectiveFrom: "2026-02-30",
    }).success,
    false,
  );
  assert.equal(
    benefitProgramPatchBody.safeParse({
      action: "update",
      reason: "Rate review",
      changeEffectiveFrom: "11/10/2026",
    }).success,
    false,
  );
  assert.equal(
    benefitProgramPatchBody.safeParse({
      action: "update",
      changeEffectiveFrom: "2026-10-11",
    }).success,
    false,
  );
});

test("program approvals are configured only in tenant Flows and retired module switches refuse", () => {
  const create = {
    action: "create",
    code: "REWARD",
    name: "Recognition",
    family: "reward",
    currency: "USD",
    effectiveFrom: "2026-01-01",
  };
  assert.equal(benefitProgramPostBody.safeParse(create).success, true);
  for (const approvalMode of ["none", "flows", "manual"]) {
    assert.equal(benefitProgramPostBody.safeParse({ ...create, approvalMode }).success, false);
    assert.equal(
      benefitProgramPatchBody.safeParse({
        action: "update",
        approvalMode,
        reason: "Change routing",
      }).success,
      false,
    );
  }
});

test("program create retains and validates a supplied audit reason", () => {
  const body = {
    action: "create",
    code: "REASON",
    name: "Reviewed program",
    family: "reward",
    currency: "CAD",
    effectiveFrom: "2026-01-01",
  };
  const parsed = benefitProgramPostBody.parse({
    ...body,
    reason: "  Approved compensation policy  ",
  });
  assert.equal(parsed.action, "create");
  if (parsed.action === "create") assert.equal(parsed.reason, "Approved compensation policy");
  for (const reason of [null, 12, {}, "", "  ", "x".repeat(2001)]) {
    assert.equal(benefitProgramPostBody.safeParse({ ...body, reason }).success, false);
  }
});

test("program activation and membership retain their supplied audit reasons", () => {
  const commands = [
    { action: "activate" },
    { action: "addMember", employmentId: UUID, effectiveFrom: "2026-01-01" },
  ];
  for (const command of commands) {
    const parsed = benefitProgramPostBody.parse({
      ...command,
      reason: "  Approved eligible programme  ",
    });
    assert.ok(parsed.action === "activate" || parsed.action === "addMember");
    if (parsed.action === "activate" || parsed.action === "addMember")
      assert.equal(parsed.reason, "Approved eligible programme");
    for (const reason of [null, 12, {}, "", "  ", "x".repeat(2001)])
      assert.equal(benefitProgramPostBody.safeParse({ ...command, reason }).success, false);
  }
});
