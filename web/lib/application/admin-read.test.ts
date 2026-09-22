import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const SOURCE = readFileSync(new URL("./admin-read.ts", import.meta.url), "utf8");
const auditStart = SOURCE.indexOf("export async function listApplicationAuditEvents");
const auditBody = SOURCE.slice(auditStart);

test("admin reads never select credentials or key material", () => {
  assert.doesNotMatch(SOURCE, /password|key_hash|secret|tin_encrypted|birth_date/i);
  assert.match(SOURCE, /assertApplicationPermission\(context, "admin\.users\.manage"\)/);
  assert.match(SOURCE, /assertApplicationPermission\(context, "admin\.roles\.manage"\)/);
  assert.match(SOURCE, /assertApplicationPermission\(context, "admin\.audit\.read"\)/);
});

test("audit list refuses subsidiary-scoped callers with the org-wide message", () => {
  assert.match(SOURCE, /ADMIN_AUDIT_ORG_WIDE_REFUSAL/);
  assert.match(
    SOURCE,
    /throw new ApplicationError\("forbidden", ADMIN_AUDIT_ORG_WIDE_REFUSAL, 403\)/,
  );
  assert.match(auditBody, /assertUnrestrictedAudit/);
  assert.doesNotMatch(auditBody, /return \[\]/);
});
