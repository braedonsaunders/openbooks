import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * Contract checks for the vendor compliance mutation boundary.  The live
 * PostgreSQL cases in web/lib/compliance-vendor-audit.integration.test.ts
 * exercise the handler; this always-on check keeps the critical transaction,
 * lock, and stored-row evidence shape visible to reviewers even when a local
 * runner has no database configured.
 */
const source = readFileSync(fileURLToPath(new URL("./route.ts", import.meta.url)), "utf8");

test("vendor compliance writes lock the tenant row and audit the stored before/after state", () => {
  assert.match(source, /withOrgTransaction\(orgId/);
  assert.match(source, /from vendor_roles[\s\S]*for update/);
  assert.match(source, /update vendor_roles[\s\S]*returning \$\{VENDOR_ROLE_AUDIT_COLUMNS\}/);
  assert.match(source, /insert into audit_log[\s\S]*JSON\.stringify\(\{ reason, before, after \}\)/);
  assert.doesNotMatch(source, /after:\s*\{ \.\.\.body/);
});

test("TIN audit snapshots never select or serialize the encrypted value", () => {
  assert.match(source, /tin_present/);
  assert.doesNotMatch(source, /tin_encrypted\s+as/);
  assert.doesNotMatch(source, /after[\s\S]*body\.tin[\s\S]*changed/);
});
