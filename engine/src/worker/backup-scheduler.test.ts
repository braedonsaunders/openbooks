import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const scheduler = readFileSync("engine/src/worker/backup-scheduler.ts", "utf8");
const backup = readFileSync("engine/src/backup.ts", "utf8");
const backupPolicy = readFileSync("web/app/api/admin/backups/policy/route.ts", "utf8");
const manualPurge = readFileSync("web/app/api/admin/backups/[id]/route.ts", "utf8");
const storedDownload = readFileSync("web/app/api/admin/backups/[id]/download/route.ts", "utf8");
const storedManifest = readFileSync("web/app/api/admin/backups/[id]/manifest/route.ts", "utf8");
const directDownload = readFileSync("web/app/api/admin/backups/download/route.ts", "utf8");

test("scheduled backup claim and ledger creation share one SQL statement", () => {
  const claim = scheduler.match(/with claimed as \([\s\S]*?returning id`/)?.[0] ?? "";
  assert.match(claim, /update backup_policies/);
  assert.match(claim, /returning org_id/);
  assert.match(claim, /insert into backup_runs/);
  assert.match(claim, /select org_id, 'scheduled', 'queued' from claimed/);
  assert.doesNotMatch(scheduler, /const claimed =/);
});

test("an existing in-flight run leaves the schedule due for a later retry", () => {
  assert.match(scheduler, /postgresError\.code === "23505"/);
  assert.match(scheduler, /backup_runs_one_inflight_per_org/);
  assert.match(scheduler, /if \(run\.rows\.length === 0\) continue/);
});

test("stored backup upload is recoverable and retention cannot relabel completion", () => {
  const intent = backup.indexOf("Persist a deterministic upload intent");
  const upload = backup.indexOf("await putBackupObject");
  const completion = backup.indexOf("set status = 'completed'");
  const rotation = backup.indexOf("await rotateBackups");
  assert.ok(intent >= 0 && intent < upload);
  assert.ok(upload < completion && completion < rotation);
  assert.match(backup, /state\?\.status === "completed"/);
  assert.match(backup, /backup_retention_failed/);
});

test("backup policy changes commit with their mandatory audit evidence", () => {
  const transaction =
    backupPolicy.match(/await withOrgTransaction\(orgId, async \(\) => \{([\s\S]*?)\n  \}\);/)?.[1] ?? "";
  const mutation = transaction.indexOf("insert into backup_policies");
  const evidence = transaction.indexOf("await auditBackupEvent");
  assert.ok(mutation >= 0 && mutation < evidence);
});

test("backup purges persist intent before storage deletion and atomically record completion", () => {
  const start = backup.indexOf("export async function purgeBackupRun");
  const purge = start < 0 ? "" : backup.slice(start, backup.indexOf("\n}\n", start) + 3);
  const intent = purge.indexOf("await auditBackupEvent");
  const deletion = purge.indexOf("await deleteBackupObject");
  const completion = purge.indexOf("return withOrgTransaction");
  const stamp = purge.indexOf("set purged_at = now()");
  const evidence = purge.lastIndexOf("await auditBackupEvent");
  assert.ok(intent >= 0 && intent < deletion && deletion < completion && completion < stamp && stamp < evidence);
  assert.match(purge, /purged_at is null[\s\S]*returning id/);
  assert.match(manualPurge, /await purgeBackupRun/);
  assert.match(backup, /rotateBackups[\s\S]*await purgeBackupRun/);
});

test("stale upload reconciliation requires exact object hash and size", () => {
  assert.match(scheduler, /status = 'running' and updated_at < now\(\) - interval '6 hours'/);
  assert.match(backup, /update backup_runs set updated_at = now\(\)/);
  assert.match(scheduler, /object\.Metadata\?\.sha256 === run\.sha256/);
  assert.match(scheduler, /String\(object\.ContentLength\) === run\.byte_size/);
  assert.match(scheduler, /cannot reconcile .* will retry/);
});

test("reconciled completion stamps its ledger row and evidence in one tenant transaction", () => {
  const start = scheduler.indexOf("if (recovered) {");
  const unit = scheduler.slice(start, scheduler.indexOf("} else {", start));
  const transaction = unit.indexOf("await withOrgTransaction(run.org_id");
  const stamp = unit.indexOf("set status = 'completed'");
  const evidence = unit.lastIndexOf("await auditBackupEvent");
  // An audit outage must roll the completed stamp back to 'running' so the
  // next tick retries the same reconciliation — never a completed run whose
  // evidence was lost in a separate, later write.
  assert.ok(transaction >= 0 && transaction < stamp && stamp < evidence);
  assert.ok(unit.lastIndexOf("updated_at < now() - interval '6 hours'") > stamp);
});

test("abandoned uploads fail only inside an audit-evidenced transaction", () => {
  const start = scheduler.indexOf("} else {");
  const unit = scheduler.slice(
    start,
    scheduler.indexOf("// A synchronous cleanup may have failed", start),
  );
  const transaction = unit.indexOf("await withOrgTransaction(run.org_id");
  const stamp = unit.indexOf("set status = 'failed'");
  const evidence = unit.indexOf('"backup_upload_abandoned"');
  assert.ok(transaction >= 0 && transaction < stamp && stamp < evidence);
});

test("orphan storage cleanup persists removal-request evidence before touching storage", () => {
  const start = scheduler.indexOf("const failedUploads = await withBypassContext");
  const region = scheduler.slice(
    start,
    scheduler.indexOf("const due = await withBypassContext", start),
  );
  const requested = region.indexOf('"backup_orphan_cleanup_requested"');
  const deletion = region.indexOf("deleteBackupObject");
  const removed = region.indexOf('"backup_orphan_removed"');
  // Evidence first: if the audit write fails, no bytes are destroyed. The
  // ledger reference is cleared together with removal confirmation evidence.
  assert.ok(requested >= 0 && requested < deletion && deletion < removed);
  assert.match(region, /object key does not match its ledger identity/);
  assert.doesNotMatch(region.slice(0, requested), /deleteBackupObject/);
});

test("backup completion and failure stamps commit their evidence inside the finalizing transaction", () => {
  for (const [startAnchor, endAnchor] of [
    ["Completion and its evidence are one atomic unit", "completed = true;"],
    ["The failed stamp and its evidence commit atomically", "} else {"],
  ] as const) {
    const start = backup.indexOf(startAnchor);
    const unit = backup.slice(start, backup.indexOf(endAnchor, start));
    const transaction = unit.indexOf("withOrgTransaction(run.org_id");
    const evidence = unit.lastIndexOf("await auditBackupEvent");
    assert.ok(transaction >= 0 && transaction < evidence, startAnchor);
  }
});

test("stored downloads write disclosure evidence before object bytes are read or served", () => {
  const evidence = storedDownload.indexOf("await auditBackupEvent");
  const read = storedDownload.indexOf("getBackupObject(run.object_key)");
  const serve = storedDownload.indexOf("Readable.toWeb");
  assert.ok(evidence >= 0 && evidence < read && read < serve);
});

test("manifest disclosure is evidenced before its response body exists", () => {
  const evidence = storedManifest.indexOf("await auditBackupEvent");
  const body = storedManifest.indexOf("JSON.stringify(manifest");
  assert.ok(evidence >= 0 && evidence < body);
});

test("browser recovery artifacts are ledger-backed and fail closed on metadata", () => {
  assert.match(directDownload, /status:\s*410/);
  assert.match(storedDownload, /object\.Metadata\?\.sha256 !== run\.sha256/);
  assert.match(storedDownload, /typeof object\.ContentLength !== "number"/);
  assert.match(storedDownload, /Content-Digest/);
});
