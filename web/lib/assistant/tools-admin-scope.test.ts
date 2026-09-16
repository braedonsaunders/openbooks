import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const admin = read("./tools-admin.ts");

// Admin reads mirror the admin pages' gates: users, roles, and API keys each
// keep their own manage permission, and the audit log keeps its org-wide
// scope rule (deleted records carry no inferable scope).
test("admin reads keep the admin pages' permission boundaries", () => {
  assert.match(admin, /name: "list_users"/);
  assert.match(admin, /name: "list_roles"/);
  assert.match(admin, /name: "list_api_keys"/);
  assert.match(admin, /name: "search_audit_log"/);
  assert.match(admin, /name: "get_outbox_status"/);
  assert.match(admin, /perms: \["admin\.users\.manage"\]/);
  assert.match(admin, /perms: \["admin\.roles\.manage"\]/);
  assert.match(admin, /perms: \["api\.keys\.manage"\]/);
  assert.match(admin, /feature: "apiAccess"/);
  assert.match(admin, /perms: \["admin\.audit\.read"\]/);
  assert.match(admin, /function adminScopeDenied/);
  assert.match(admin, /allowedSubsidiaryIds === null \? null : \{ ok: false, error: "forbidden" \}/);
  const audit = admin.slice(admin.indexOf('name: "search_audit_log"'));
  assert.match(audit, /adminScopeDenied\(authz\)/);
  const outbox = admin.slice(admin.indexOf('name: "get_outbox_status"'));
  assert.match(outbox, /adminScopeDenied\(authz\)/);
});

// Key material must never cross the tool boundary: the explicit column list
// from the API-keys page (prefix + 4-char preview only) is the whole surface.
test("api key reads exclude every secret-bearing column", () => {
  assert.match(admin, /key_prefix/);
  assert.match(admin, /key_preview/);
  assert.match(admin, /select k\.id, k\.name, k\.description, k\.key_prefix, k\.key_preview, k\.scopes,/);
  // No qualified secret/hash column reference anywhere in the file.
  assert.doesNotMatch(admin, /k\.\w*(secret|hash)\w*/);
  assert.doesNotMatch(admin, /key_hash/);
});

// The audit search reuses the page's record-type expression (documents split
// by kind, deleted documents recovered from the before snapshot) and the
// outbox status reads both outboxes without their payloads.
test("audit and outbox reads reuse the page query shapes", () => {
  assert.match(admin, /a\.changes #>> '\{before,document,kind\}'/);
  assert.match(admin, /from audit_log/);
  assert.match(admin, /from scheduler_outbox/);
  assert.match(admin, /from report_delivery_outbox/);
  assert.match(admin, /select kind as job, status, attempt_count/);
  assert.doesNotMatch(admin, /[\s,.]payload[\s,)]/);
  assert.doesNotMatch(admin, /lease_token/);
});
