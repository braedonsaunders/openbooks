import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("engine/src/sync/source-deletions.ts", "utf8");

test("automatic source deletions preserve settlement evidence", () => {
  const automatic = source.slice(
    source.indexOf("export async function mirrorSourceDeletion"),
    source.indexOf("export async function resolveSourceDeletion"),
  );
  assert.match(automatic, /update applications a[\s\S]*unapplied_at = now\(\)/);
  assert.doesNotMatch(automatic, /delete from applications/i);
  assert.match(automatic, /captureTransactionAuditSnapshot\(tx, document\.id, input\.orgId\)/);
  assert.doesNotMatch(automatic, /captureTransactionAuditSnapshot\(tx, document\.id\)/);
  assert.match(automatic, /recordTransactionAudit\(tx,/);
  assert.doesNotMatch(automatic, /delete from documents/i);
});

test("automatic source deletions reverse in the original accounting period", () => {
  const automatic = source.slice(
    source.indexOf("export async function mirrorSourceDeletion"),
    source.indexOf("export async function resolveSourceDeletion"),
  );
  assert.match(automatic, /postingDate: entry\.postingDate/);
  assert.match(automatic, /periodId: entry\.periodId/);
  assert.match(automatic, /status: "reversed"/);
  assert.match(automatic, /status = 'voided'/);
  assert.match(automatic, /open_balance = null/);
});

test("unposted source deletions are preserved as audited voids", () => {
  const automatic = source.slice(
    source.indexOf("export async function mirrorSourceDeletion"),
    source.indexOf("export async function resolveSourceDeletion"),
  );
  assert.match(
    automatic,
    /if \(!document\.posted_entry_id\)[\s\S]*status = 'voided'[\s\S]*recordTransactionAudit/,
  );
});

test("controller resolutions validate the actor and audit both decision and document", () => {
  const controlled = source.slice(
    source.indexOf("export async function resolveSourceDeletion"),
  );
  assert.match(controlled, /resolution actor is not an active organization user/);
  assert.match(controlled, /'source_deletion_resolutions'/);
  assert.match(controlled, /previousResolution/);
  assert.match(controlled, /currentResolution/);
});

test("resolution upserts pin the known tenant on the connection_id/source_ref conflict write", () => {
  const controlled = source.slice(
    source.indexOf("export async function resolveSourceDeletion"),
  );
  assert.match(
    controlled,
    /on conflict \(connection_id, source_ref\) do update set[\s\S]*?where source_deletion_resolutions\.org_id = \$\{input\.orgId\}/,
  );
});
