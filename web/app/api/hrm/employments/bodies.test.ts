import assert from "node:assert/strict";
import test from "node:test";
import { hireEmploymentBody } from "./bodies";

const workerPartyId = "11111111-1111-4111-8111-111111111111";
const employerSubsidiaryId = "22222222-2222-4222-8222-222222222222";

test("hire accepts the person, the legal entity, the start, and the reason", () => {
  assert.deepEqual(
    hireEmploymentBody.parse({
      workerPartyId,
      employerSubsidiaryId,
      effectiveFrom: "2026-09-01",
      reason: "Founding engineer joins",
    }),
    {
      workerPartyId,
      employerSubsidiaryId,
      effectiveFrom: "2026-09-01",
      reason: "Founding engineer joins",
    },
  );
  assert.deepEqual(
    hireEmploymentBody.parse({
      workerPartyId,
      employerSubsidiaryId,
      status: "offered",
      effectiveFrom: "2026-09-01",
      effectiveTo: null,
      reason: "Offer accepted",
    }).status,
    "offered",
  );
});

test("hire refuses a missing person, entity, start, or reason at the boundary", () => {
  assert.equal(
    hireEmploymentBody.safeParse({ employerSubsidiaryId, effectiveFrom: "2026-09-01", reason: "x" }).success,
    false,
  );
  assert.equal(
    hireEmploymentBody.safeParse({ workerPartyId, effectiveFrom: "2026-09-01", reason: "x" }).success,
    false,
  );
  assert.equal(
    hireEmploymentBody.safeParse({ workerPartyId, employerSubsidiaryId, reason: "x" }).success,
    false,
  );
  assert.equal(
    hireEmploymentBody.safeParse({
      workerPartyId,
      employerSubsidiaryId,
      effectiveFrom: "2026-09-01",
      reason: "   ",
    }).success,
    false,
  );
  assert.equal(
    hireEmploymentBody.safeParse({
      workerPartyId: "not-a-uuid",
      employerSubsidiaryId,
      effectiveFrom: "2026-09-01",
      reason: "x",
    }).success,
    false,
  );
  assert.equal(
    hireEmploymentBody.safeParse({
      workerPartyId,
      employerSubsidiaryId,
      status: "terminated",
      effectiveFrom: "2026-09-01",
      reason: "x",
    }).success,
    false,
  );
});
