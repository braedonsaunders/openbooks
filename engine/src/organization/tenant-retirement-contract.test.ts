import assert from "node:assert/strict";
import test from "node:test";
import { parseTenantRetirementRecovery } from "./tenant-retirement-contract.ts";

const evidence = {
  backupSha256: "a".repeat(64), restoreReceiptSha256: "b".repeat(64),
  preservationReceiptSha256: "c".repeat(64), objectRetentionReceiptSha256: "d".repeat(64),
  verifiedAt: "2026-10-09T14:00:00.000Z", verifier: "Database operator",
};
test("retirement requires all recovery artifacts, including object retention", () => {
  assert.deepEqual(parseTenantRetirementRecovery(evidence), evidence);
  for (const key of Object.keys(evidence)) {
    const incomplete: Record<string, unknown> = { ...evidence };
    delete incomplete[key];
    assert.throws(() => parseTenantRetirementRecovery(incomplete), /exactly/);
  }
});
test("caller flags and incomplete hashes cannot replace recovery evidence", () => {
  assert.throws(() => parseTenantRetirementRecovery({ ...evidence, bypass: true }), /exactly/);
  assert.throws(() => parseTenantRetirementRecovery({ ...evidence, backupSha256: "approved" }), /SHA256/);
  assert.throws(() => parseTenantRetirementRecovery({ ...evidence, verifiedAt: "yesterday" }), /timestamp/);
  assert.throws(() => parseTenantRetirementRecovery({ ...evidence, verifier: "" }), /verifier/);
});
