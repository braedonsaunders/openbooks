import test from "node:test";
import assert from "node:assert/strict";
import { bindHolidayPaymentSource, readHolidayPaymentSourceReference } from "./holiday-payment-source.ts";

const orgId = "10000000-0000-4000-8000-000000000001";
const fileId = "10000000-0000-4000-8000-000000000002";
const versionId = "10000000-0000-4000-8000-000000000003";
const foreignId = "10000000-0000-4000-8000-000000000004";
const instruction = {
  employeePartyId: "10000000-0000-4000-8000-000000000005",
  holidayDates: ["2025-12-25", "2025-12-26", "2026-01-01"],
  hours: "24", assessedOn: "2026-01-10", wageBasisDate: "2026-01-10", paymentDate: "2026-01-16",
  instructionKey: "owed-holiday-hours", sourceReference: "Approved payroll request, row 13", sourceDigest: "a".repeat(64),
};
const reference = { fileId, versionId };
const retained = { orgId, fileId, versionId, versionNumber: 1, contentHash: "a".repeat(64), fileInactive: false, folderInactive: false };

test("holiday evidence freezes the selected version and its source digest without allocating aggregate hours", () => {
  const frozen = bindHolidayPaymentSource(orgId, instruction, reference, retained);
  assert.deepEqual(frozen.source, { ...reference, versionNumber: 1, contentHash: retained.contentHash });
  assert.equal(frozen.instruction.hours, "24.00");
  assert.deepEqual(frozen.instruction.holidayDates, instruction.holidayDates);
  // A second upload must be selected explicitly with its own digest.
  assert.throws(() => bindHolidayPaymentSource(orgId, instruction, reference, { ...retained, versionId: foreignId, versionNumber: 2 }), /available retained version/);
  assert.throws(() => bindHolidayPaymentSource(orgId, instruction, reference, { ...retained, contentHash: "b".repeat(64) }), /digest differs/);
});

test("holiday source binding refuses foreign, retired, absent and unverifiable evidence", () => {
  assert.throws(() => bindHolidayPaymentSource(orgId, instruction, reference, null));
  for (const changes of [
    { orgId: foreignId }, { fileId: foreignId }, { versionId: foreignId },
    { fileInactive: true }, { folderInactive: true }, { versionNumber: 0 },
    { versionNumber: 1.5 }, { contentHash: null }, { contentHash: "unverified" },
  ]) assert.throws(() => bindHolidayPaymentSource(orgId, instruction, reference, { ...retained, ...changes }), undefined, JSON.stringify(changes));
  assert.throws(() => bindHolidayPaymentSource("unknown", instruction, reference, retained));
  assert.throws(() => bindHolidayPaymentSource(orgId, { ...instruction, amount: "1080" }, reference, retained));
});

test("source version references refuse mutable pointers, implicit versions and extra override fields", () => {
  for (const value of [null, [], { fileId }, { versionId }, { ...reference, amount: "1080" },
    { ...reference, currentVersionId: versionId }, { fileId: "unknown", versionId }]) {
    assert.throws(() => readHolidayPaymentSourceReference(value));
  }
  assert.deepEqual(readHolidayPaymentSourceReference({ fileId: fileId.toUpperCase(), versionId: versionId.toUpperCase() }), reference);
  assert.equal(bindHolidayPaymentSource(orgId, instruction, reference, { ...retained, contentHash: retained.contentHash.toUpperCase() }).source.contentHash, retained.contentHash);
});
