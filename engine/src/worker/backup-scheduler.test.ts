import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const scheduler = readFileSync("engine/src/worker/backup-scheduler.ts", "utf8");
const backup = readFileSync("engine/src/backup.ts", "utf8");
const backupPolicy = readFileSync("web/app/api/admin/backups/policy/route.ts", "utf8");
const manualPurge = readFileSync("web/app/api/admin/backups/[id]/route.ts", "utf8");
const storedDownload = readFileSync("web/app/api/admin/backups/[id]/download/route.ts", "utf8");
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

test("browser recovery artifacts are ledger-backed and fail closed on metadata", () => {
  assert.match(directDownload, /status:\s*410/);
  assert.match(storedDownload, /object\.Metadata\?\.sha256 !== run\.sha256/);
  assert.match(storedDownload, /typeof object\.ContentLength !== "number"/);
  assert.match(storedDownload, /Content-Digest/);
});
