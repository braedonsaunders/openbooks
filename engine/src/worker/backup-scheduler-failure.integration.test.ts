import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { sql } from "drizzle-orm";
import { backupObjectKey } from "../backup/backup.ts";
import { getS3Client } from "../platform/file-storage.ts";
import { db } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { tick } from "./backup-scheduler.ts";

// Failure-injection seam: tick reaches storage only through the shared S3
// client's send(), so mocking send() exercises the real reconcile/orphan
// paths (lock claim, head, delete, ledger stamp, audit) with no network.
const DB = Boolean(process.env.OPENBOOKS_DB_URL);

function mockS3Send(t: TestContext, headImpl: (key: string) => unknown, deleted: string[]) {
  const client = getS3Client();
  t.mock.method(client, "send", async (command: unknown) => {
    const cmd = command as { constructor: { name: string }; input: { Key?: string } };
    if (cmd.constructor.name === "HeadObjectCommand") return headImpl(cmd.input.Key ?? "");
    if (cmd.constructor.name === "DeleteObjectCommand") {
      deleted.push(cmd.input.Key ?? "");
      return {};
    }
    throw new Error(`unexpected S3 operation in backup-scheduler test: ${cmd.constructor.name}`);
  });
}

function notFoundError(): Error {
  const err = new Error("NoSuchKey: the specified key does not exist") as Error & { name: string };
  err.name = "NotFound";
  return err;
}

async function cleanupOrg(orgId: string): Promise<void> {
  // backup_runs/backup_policies are outside dropScratchOrg's teardown scope;
  // audit_log is append-only by guard, so its evidence rows stay (org-scoped).
  await db.execute(sql`delete from backup_runs where org_id = ${orgId}`);
  await db.execute(sql`delete from backup_policies where org_id = ${orgId}`);
}

async function auditEvents(orgId: string, rowId: string): Promise<string[]> {
  const res = await db.execute<{ event: string }>(sql`
    select changes->>'event' as event from audit_log
     where org_id = ${orgId} and row_id = ${rowId} order by id`);
  return res.rows.map((r) => r.event);
}

async function seedStaleRunning(
  orgId: string,
  row: { objectKey: string | null; sha256: string | null; byteSize: number | null },
): Promise<string> {
  const inserted = await db.execute<{ id: string }>(sql`
    insert into backup_runs (org_id, kind, status, object_key, sha256, byte_size)
    values (${orgId}, 'scheduled', 'running', ${row.objectKey}, ${row.sha256}, ${row.byteSize})
    returning id`);
  const id = inserted.rows[0]!.id;
  await db.execute(sql`update backup_runs set updated_at = now() - interval '7 hours' where id = ${id}`);
  return id;
}

test("a stale running run whose object verifies is completed with reconciliation evidence", { skip: !DB }, async (t) => {
  const org = await createScratchOrg();
  const deleted: string[] = [];
  try {
    const sha = "a".repeat(64);
    const size = 123456;
    const key = `backups/${org.orgId}/pending`;
    const runId = await seedStaleRunning(org.orgId, { objectKey: key, sha256: sha, byteSize: size });
    mockS3Send(t, () => ({ Metadata: { sha256: sha }, ContentLength: size }), deleted);

    await tick();

    const res = await db.execute<{ status: string; error: string | null; object_key: string | null }>(sql`
      select status, error, object_key from backup_runs where id = ${runId}`);
    assert.equal(res.rows[0]!.status, "completed");
    assert.equal(res.rows[0]!.error, null);
    assert.equal(res.rows[0]!.object_key, key);
    assert.deepEqual(deleted, [], "a verified object must not be deleted");
    const events = await auditEvents(org.orgId, runId);
    assert.ok(events.includes("backup_upload_reconciled"), `expected reconciliation evidence, saw: ${events}`);
  } finally {
    await cleanupOrg(org.orgId);
    await dropScratchOrg(org.orgId);
  }
});

test("a stale running run whose object is gone from storage is failed with the reason recorded", { skip: !DB }, async (t) => {
  const org = await createScratchOrg();
  const deleted: string[] = [];
  try {
    const runId = await seedStaleRunning(org.orgId, {
      objectKey: `backups/${org.orgId}/pending`,
      sha256: "b".repeat(64),
      byteSize: 42,
    });
    mockS3Send(t, () => {
      throw notFoundError();
    }, deleted);

    await tick();

    const res = await db.execute<{ status: string; error: string | null; object_key: string | null }>(sql`
      select status, error, object_key from backup_runs where id = ${runId}`);
    assert.equal(res.rows[0]!.status, "failed");
    assert.equal(res.rows[0]!.object_key, null);
    assert.match(res.rows[0]!.error ?? "", /before the upload could be verified/);
    const events = await auditEvents(org.orgId, runId);
    assert.ok(events.includes("backup_upload_abandoned"), `expected abandonment evidence, saw: ${events}`);
  } finally {
    await cleanupOrg(org.orgId);
    await dropScratchOrg(org.orgId);
  }
});

test("a stale running run whose object mismatches the ledger hash is deleted from storage, then failed", { skip: !DB }, async (t) => {
  const org = await createScratchOrg();
  const deleted: string[] = [];
  try {
    const key = `backups/${org.orgId}/pending`;
    const runId = await seedStaleRunning(org.orgId, { objectKey: key, sha256: "c".repeat(64), byteSize: 99 });
    mockS3Send(t, () => ({ Metadata: { sha256: "d".repeat(64) }, ContentLength: 99 }), deleted);

    await tick();

    assert.deepEqual(deleted, [key], "the mismatched object must be removed so it cannot be mistaken for the backup");
    const res = await db.execute<{ status: string; object_key: string | null }>(sql`
      select status, object_key from backup_runs where id = ${runId}`);
    assert.equal(res.rows[0]!.status, "failed");
    assert.equal(res.rows[0]!.object_key, null);
  } finally {
    await cleanupOrg(org.orgId);
    await dropScratchOrg(org.orgId);
  }
});

test("a stale running run whose object size mismatches the ledger is deleted from storage, then failed", { skip: !DB }, async (t) => {
  const org = await createScratchOrg();
  const deleted: string[] = [];
  try {
    const key = `backups/${org.orgId}/pending`;
    const sha = "1".repeat(64);
    const runId = await seedStaleRunning(org.orgId, { objectKey: key, sha256: sha, byteSize: 99 });
    mockS3Send(t, () => ({ Metadata: { sha256: sha }, ContentLength: 100 }), deleted);

    await tick();

    assert.deepEqual(deleted, [key], "the wrong-sized object must not be accepted as the ledger backup");
    const res = await db.execute<{ status: string; object_key: string | null }>(sql`
      select status, object_key from backup_runs where id = ${runId}`);
    assert.equal(res.rows[0]!.status, "failed");
    assert.equal(res.rows[0]!.object_key, null);
  } finally {
    await cleanupOrg(org.orgId);
    await dropScratchOrg(org.orgId);
  }
});

test("a storage outage leaves the stale running run untouched for a later tick", { skip: !DB }, async (t) => {
  const org = await createScratchOrg();
  const deleted: string[] = [];
  try {
    const runId = await seedStaleRunning(org.orgId, {
      objectKey: `backups/${org.orgId}/pending`,
      sha256: "e".repeat(64),
      byteSize: 7,
    });
    mockS3Send(t, () => {
      throw new Error("connect ECONNREFUSED 10.0.0.9:9000");
    }, deleted);

    await tick();

    const res = await db.execute<{ status: string; object_key: string | null }>(sql`
      select status, object_key from backup_runs where id = ${runId}`);
    assert.equal(res.rows[0]!.status, "running", "an undecided probe must not destroy evidence");
    assert.deepEqual(deleted, []);
    assert.deepEqual(await auditEvents(org.orgId, runId), [], "no verdict means no evidence rows");
  } finally {
    await cleanupOrg(org.orgId);
    await dropScratchOrg(org.orgId);
  }
});

test("a due schedule claims exactly one scheduled run and advances past now", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await db.execute(sql`
      insert into backup_policies (org_id, enabled, frequency, next_run_at)
      values (${org.orgId}, true, 'daily', now() - interval '1 hour')`);

    await tick();

    const runs = await db.execute<{ kind: string; status: string }>(sql`
      select kind, status from backup_runs where org_id = ${org.orgId}`);
    assert.equal(runs.rows.length, 1, "exactly one scheduled run must be claimed");
    assert.equal(runs.rows[0]!.kind, "scheduled");
    const policy = await db.execute<{ next_run_at: string }>(sql`
      select next_run_at from backup_policies where org_id = ${org.orgId}`);
    assert.ok(
      new Date(policy.rows[0]!.next_run_at).getTime() > Date.now(),
      "the claim must advance next_run_at so a second scanner stands down",
    );
  } finally {
    await cleanupOrg(org.orgId);
    await dropScratchOrg(org.orgId);
  }
});

test("a claim lost to another scanner inserts no run", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await db.execute(sql`
      insert into backup_policies (org_id, enabled, frequency, next_run_at)
      values (${org.orgId}, true, 'daily', now() - interval '1 hour')`);
    // Another scheduler wins the race before this tick scans.
    await db.execute(sql`
      update backup_policies set next_run_at = now() + interval '1 day' where org_id = ${org.orgId}`);

    await tick();

    const runs = await db.execute<{ id: string }>(sql`
      select id from backup_runs where org_id = ${org.orgId}`);
    assert.equal(runs.rows.length, 0, "a lost claim must not insert a duplicate scheduled run");
  } finally {
    await cleanupOrg(org.orgId);
    await dropScratchOrg(org.orgId);
  }
});

test("an in-flight run blocks the scheduled claim and leaves the schedule due", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await db.execute(sql`
      insert into backup_runs (org_id, kind, status) values (${org.orgId}, 'manual', 'running')`);
    await db.execute(sql`
      insert into backup_policies (org_id, enabled, frequency, next_run_at)
      values (${org.orgId}, true, 'daily', now() - interval '1 hour')`);

    await tick();

    const runs = await db.execute<{ kind: string }>(sql`
      select kind from backup_runs where org_id = ${org.orgId}`);
    assert.equal(runs.rows.length, 1, "the conflicting claim must roll back, not queue a second run");
    const policy = await db.execute<{ next_run_at: string }>(sql`
      select next_run_at from backup_policies where org_id = ${org.orgId}`);
    assert.ok(
      new Date(policy.rows[0]!.next_run_at).getTime() < Date.now(),
      "the schedule must stay due so a later tick retries after the in-flight run lands",
    );
  } finally {
    await cleanupOrg(org.orgId);
    await dropScratchOrg(org.orgId);
  }
});

test("completed and fresh running rows are never reconciled", { skip: !DB }, async (t) => {
  const org = await createScratchOrg();
  const deleted: string[] = [];
  try {
    const sha = "f".repeat(64);
    const done = await db.execute<{ id: string }>(sql`
      insert into backup_runs (org_id, kind, status, object_key, sha256, byte_size, completed_at)
      values (${org.orgId}, 'scheduled', 'completed', ${`backups/${org.orgId}/done`}, ${sha}, 10, now())
      returning id`);
    await db.execute(sql`update backup_runs set updated_at = now() - interval '7 hours' where id = ${done.rows[0]!.id}`);
    const live = await db.execute<{ id: string }>(sql`
      insert into backup_runs (org_id, kind, status, object_key, sha256, byte_size)
      values (${org.orgId}, 'scheduled', 'running', ${`backups/${org.orgId}/live`}, ${sha}, 10)
      returning id`);
    mockS3Send(t, () => ({ Metadata: { sha256: "0".repeat(64) }, ContentLength: 10 }), deleted);

    await tick();

    // Even a mismatching head must not touch rows outside the stale-running
    // scan: the completed backup keeps its object, the live worker keeps its row.
    assert.deepEqual(deleted, [], "reconciliation must not delete outside stale running runs");
    const rows = await db.execute<{ id: string; status: string; object_key: string | null }>(sql`
      select id, status, object_key from backup_runs where org_id = ${org.orgId} order by id`);
    assert.equal(rows.rows.length, 2);
    for (const row of rows.rows) {
      assert.ok([done.rows[0]!.id, live.rows[0]!.id].includes(row.id));
    }
    assert.deepEqual(
      rows.rows.map((r) => r.status).sort(),
      ["completed", "running"],
    );
  } finally {
    await cleanupOrg(org.orgId);
    await dropScratchOrg(org.orgId);
  }
});

test("a failed run's canonical orphan object is deleted with evidence before the ledger reference clears", { skip: !DB }, async (t) => {
  const org = await createScratchOrg();
  const deleted: string[] = [];
  try {
    const inserted = await db.execute<{ id: string }>(sql`
      insert into backup_runs (org_id, kind, status) values (${org.orgId}, 'scheduled', 'failed') returning id`);
    const runId = inserted.rows[0]!.id;
    const key = backupObjectKey(org.orgId, runId);
    await db.execute(sql`update backup_runs set object_key = ${key} where id = ${runId}`);
    mockS3Send(t, () => {
      throw new Error("head must not be consulted on the orphan path");
    }, deleted);

    await tick();

    assert.deepEqual(deleted, [key]);
    const res = await db.execute<{ object_key: string | null }>(sql`
      select object_key from backup_runs where id = ${runId}`);
    assert.equal(res.rows[0]!.object_key, null);
    const events = await auditEvents(org.orgId, runId);
    assert.deepEqual(
      events,
      ["backup_orphan_cleanup_requested", "backup_orphan_removed"],
      "the removal request must be durable before storage is touched",
    );
  } finally {
    await cleanupOrg(org.orgId);
    await dropScratchOrg(org.orgId);
  }
});

test("a failed run's non-canonical object key is refused orphan cleanup", { skip: !DB }, async (t) => {
  const org = await createScratchOrg();
  const deleted: string[] = [];
  try {
    const inserted = await db.execute<{ id: string }>(sql`
      insert into backup_runs (org_id, kind, status, object_key)
      values (${org.orgId}, 'scheduled', 'failed', 'backups/stray-bucket-copy.gz') returning id`);
    const runId = inserted.rows[0]!.id;
    mockS3Send(t, () => {
      throw new Error("no storage call is expected for a refused key");
    }, deleted);

    await tick();

    assert.deepEqual(deleted, [], "a key outside the run's ledger identity must never be deleted");
    const res = await db.execute<{ object_key: string | null }>(sql`
      select object_key from backup_runs where id = ${runId}`);
    assert.equal(res.rows[0]!.object_key, "backups/stray-bucket-copy.gz");
    const events = await auditEvents(org.orgId, runId);
    assert.ok(!events.includes("backup_orphan_removed"), `refused keys leave no removal evidence, saw: ${events}`);
  } finally {
    await cleanupOrg(org.orgId);
    await dropScratchOrg(org.orgId);
  }
});
