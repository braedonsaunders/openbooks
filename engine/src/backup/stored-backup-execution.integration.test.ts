import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { db, withOrgContext } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";

interface StoredObject {
  key: string;
  byteLength: number;
  fileName: string;
  sha256: string;
  bytes: Buffer;
}

interface BackupS3Client {
  send(command: unknown): Promise<unknown>;
}

const storage: { client: BackupS3Client; uploaded: StoredObject | null } = {
  client: { send: async () => { throw new Error("unexpected backup storage request"); } },
  uploaded: null,
};
const storageKey = Symbol.for("openbooks.stored-backup-execution-test");
(globalThis as Record<symbol, unknown>)[storageKey] = storage;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "../platform/file-storage.ts" && context.parentURL?.endsWith("/backup/backup.ts")) {
      return { url: "mock:backup-execution-storage", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:backup-execution-storage") {
      return {
        format: "module",
        source: `
          const storage = globalThis[Symbol.for("openbooks.stored-backup-execution-test")]
          export const s3Enabled = true
          export const s3Bucket = () => "test-backups"
          export const getS3Client = () => storage.client
        `,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

const { backupObjectKey, executeBackupRun, purgeBackupRun, rotateBackups } = await import("./backup.ts");
hooks.deregister();

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

test("a queued run remains completed with exact evidence when post-completion retention fails", { skip: !DB }, async (t) => {
  const org = await createScratchOrg();
  storage.uploaded = null;
  try {
    const inserted = await db.execute<{ id: string }>(sql`
      insert into backup_runs (org_id, kind, status)
      values (${org.orgId}, 'manual', 'queued') returning id`);
    const runId = inserted.rows[0]!.id;
    let uploadCount = 0;
    storage.client = {
      async send(command: unknown) {
        const request = command as {
          constructor: { name: string };
          input: {
            Key?: string;
            Body?: AsyncIterable<Uint8Array>;
            ContentLength?: number;
            ContentDisposition?: string;
            Metadata?: { sha256?: string };
          };
        };
        assert.equal(request.constructor.name, "PutObjectCommand");
        uploadCount += 1;
        const chunks: Buffer[] = [];
        for await (const chunk of request.input.Body!) chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks);
        const fileName = /filename="([^"]+)"/.exec(request.input.ContentDisposition ?? "")?.[1] ?? "";
        storage.uploaded = {
          key: request.input.Key ?? "",
          byteLength: request.input.ContentLength ?? -1,
          fileName,
          sha256: request.input.Metadata?.sha256 ?? "",
          bytes,
        };
        return {};
      },
    };

    const execute = db.execute.bind(db);
    t.mock.method(db, "execute", async (query: Parameters<typeof db.execute>[0]) => {
      const statement = new PgDialect().sqlToQuery(query as SQL).sql;
      if (statement.includes("select max_keep from backup_policies")) {
        throw new Error("injected retention policy read outage");
      }
      return execute(query);
    });

    await executeBackupRun(runId);

    const run = (await db.execute<{
      status: string;
      object_key: string | null;
      file_name: string | null;
      byte_size: number | string | null;
      sha256: string | null;
    }>(sql`
      select status, object_key, file_name, byte_size, sha256
        from backup_runs where org_id = ${org.orgId} and id = ${runId}`)).rows[0]!;
    const evidence = (await db.execute<{ changes: { event: string; sha256?: string; byteSize?: number; error?: string } }>(sql`
      select changes from audit_log
       where org_id = ${org.orgId} and row_id = ${runId} order by id`)).rows;
    const uploaded = storage.uploaded!;

    assert.equal(uploadCount, 1);
    assert.equal(uploaded.key, backupObjectKey(org.orgId, runId));
    assert.equal(uploaded.byteLength, uploaded.bytes.byteLength);
    assert.equal(uploaded.sha256, createHash("sha256").update(uploaded.bytes).digest("hex"));
    assert.equal(run.status, "completed");
    assert.equal(run.object_key, uploaded.key);
    assert.equal(run.file_name, uploaded.fileName);
    assert.equal(Number(run.byte_size), uploaded.byteLength);
    assert.equal(run.sha256, uploaded.sha256);
    assert.ok(
      evidence.some((row) => row.changes.event === "backup_completed"
        && row.changes.sha256 === uploaded.sha256 && row.changes.byteSize === uploaded.byteLength),
      "the completed ledger entry must have audit evidence for the exact uploaded bytes",
    );
    assert.ok(
      evidence.some((row) => row.changes.event === "backup_retention_failed"
        && row.changes.error === "injected retention policy read outage"),
      "retention failure must be visible without relabeling the stored backup",
    );
  } finally {
    await db.execute(sql`delete from backup_runs where org_id = ${org.orgId}`);
    await dropScratchOrg(org.orgId);
  }
});

test("an upload failure clears its stored object and commits failure evidence", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const deletedKeys: string[] = [];
  try {
    const inserted = await db.execute<{ id: string }>(sql`
      insert into backup_runs (org_id, kind, status)
      values (${org.orgId}, 'manual', 'queued') returning id`);
    const runId = inserted.rows[0]!.id;
    storage.client = {
      async send(command: unknown) {
        const request = command as { constructor: { name: string }; input: { Key?: string } };
        if (request.constructor.name === "PutObjectCommand") throw new Error("injected upload failure");
        assert.equal(request.constructor.name, "DeleteObjectCommand");
        deletedKeys.push(request.input.Key ?? "");
        return {};
      },
    };

    await executeBackupRun(runId);

    const run = (await db.execute<{ status: string; object_key: string | null; error: string | null }>(sql`
      select status, object_key, error from backup_runs where org_id = ${org.orgId} and id = ${runId}`)).rows[0]!;
    assert.equal(run.status, "failed");
    assert.equal(run.object_key, null, "the ledger must not point at an object removed after upload failure");
    assert.equal(run.error, "injected upload failure");
    assert.deepEqual(deletedKeys, [backupObjectKey(org.orgId, runId)]);
    assert.deepEqual(
      (await db.execute<{ event: string; error: string }>(sql`
        select changes->>'event' as event, changes->>'error' as error
          from audit_log where org_id = ${org.orgId} and row_id = ${runId}`)).rows,
      [{ event: "backup_failed", error: "injected upload failure" }],
      "the failed ledger transition must be visible with its reason",
    );
  } finally {
    await db.execute(sql`delete from backup_runs where org_id = ${org.orgId}`);
    await dropScratchOrg(org.orgId);
  }
});

test("purging records durable intent before deletion and keeps the completed ledger evidence", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  let beginDelete!: () => void;
  let releaseDelete!: () => void;
  const deleteStarted = new Promise<void>((resolve) => { beginDelete = resolve; });
  const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve; });
  let deletedKey = "";
  try {
    const inserted = await db.execute<{ id: string }>(sql`
      insert into backup_runs (org_id, kind, status, object_key, file_name, byte_size, sha256, completed_at)
      values (${org.orgId}, 'manual', 'completed', 'pending', 'archive.json.gz', 20, ${"a".repeat(64)}, now())
      returning id`);
    const runId = inserted.rows[0]!.id;
    const objectKey = backupObjectKey(org.orgId, runId);
    await db.execute(sql`update backup_runs set object_key = ${objectKey} where org_id = ${org.orgId} and id = ${runId}`);
    storage.client = {
      async send(command: unknown) {
        const request = command as { constructor: { name: string }; input: { Key?: string } };
        assert.equal(request.constructor.name, "DeleteObjectCommand");
        deletedKey = request.input.Key ?? "";
        beginDelete();
        await deleteGate;
        return {};
      },
    };

    const purgePromise = withOrgContext(org.orgId, () => purgeBackupRun({
      orgId: org.orgId,
      runId,
      objectKey,
      actorId: null,
      reason: "deleted",
      kind: "manual",
      fileName: "archive.json.gz",
      byteSize: 20,
      sha256: "a".repeat(64),
    }));
    await deleteStarted;
    const eventsDuringDelete = (await db.execute<{ event: string }>(sql`
      select changes->>'event' as event from audit_log where org_id = ${org.orgId} and row_id = ${runId} order by id`))
      .rows.map((row) => row.event);
    assert.deepEqual(eventsDuringDelete, ["backup_purge_requested"]);
    assert.equal(deletedKey, objectKey);
    releaseDelete();
    assert.equal(await purgePromise, true);

    const row = (await db.execute<{ status: string; purged_at: Date | null; purge_reason: string | null }>(sql`
      select status, purged_at, purge_reason from backup_runs where org_id = ${org.orgId} and id = ${runId}`)).rows[0]!;
    assert.equal(row.status, "completed", "purge retains the immutable completed run");
    assert.ok(row.purged_at);
    assert.equal(row.purge_reason, "deleted");
    assert.deepEqual(
      (await db.execute<{ event: string }>(sql`
        select changes->>'event' as event from audit_log where org_id = ${org.orgId} and row_id = ${runId} order by id`))
        .rows.map((event) => event.event),
      ["backup_purge_requested", "backup_deleted"],
    );
  } finally {
    releaseDelete();
    await db.execute(sql`delete from backup_runs where org_id = ${org.orgId}`);
    await dropScratchOrg(org.orgId);
  }
});

test("retention preserves the newest run and audits the older run before deleting its object", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const deletedKeys: string[] = [];
  try {
    await db.execute(sql`insert into backup_policies (org_id, max_keep) values (${org.orgId}, 1)`);
    const ids: string[] = [];
    for (const [fileName, createdAt] of [
      ["older.json.gz", new Date("2026-01-01T00:00:00.000Z")],
      ["newer.json.gz", new Date("2026-01-02T00:00:00.000Z")],
    ] as const) {
      const inserted = await db.execute<{ id: string }>(sql`
        insert into backup_runs (org_id, kind, status, file_name, byte_size, sha256, completed_at, created_at)
        values (${org.orgId}, 'scheduled', 'completed', ${fileName}, 20, ${"b".repeat(64)}, ${createdAt}, ${createdAt})
        returning id`);
      const runId = inserted.rows[0]!.id;
      ids.push(runId);
      const objectKey = backupObjectKey(org.orgId, runId);
      await db.execute(sql`update backup_runs set object_key = ${objectKey} where org_id = ${org.orgId} and id = ${runId}`);
    }
    storage.client = {
      async send(command: unknown) {
        const request = command as { constructor: { name: string }; input: { Key?: string } };
        assert.equal(request.constructor.name, "DeleteObjectCommand");
        deletedKeys.push(request.input.Key ?? "");
        return {};
      },
    };

    await rotateBackups(org.orgId);

    assert.deepEqual(deletedKeys, [backupObjectKey(org.orgId, ids[0]!)]);
    const runs = (await db.execute<{ id: string; purged_at: Date | null; purge_reason: string | null }>(sql`
      select id, purged_at, purge_reason from backup_runs where org_id = ${org.orgId} order by created_at`)).rows;
    assert.ok(runs[0]!.purged_at);
    assert.equal(runs[0]!.purge_reason, "rotated");
    assert.equal(runs[1]!.id, ids[1]);
    assert.equal(runs[1]!.purged_at, null);
    assert.deepEqual(
      (await db.execute<{ event: string; max_keep: number }>(sql`
        select changes->>'event' as event, (changes->>'maxKeep')::integer as max_keep
          from audit_log where org_id = ${org.orgId} and row_id = ${ids[0]} order by id`)).rows,
      [
        { event: "backup_purge_requested", max_keep: 1 },
        { event: "backup_rotated", max_keep: 1 },
      ],
    );
  } finally {
    await db.execute(sql`delete from backup_runs where org_id = ${org.orgId}`);
    await db.execute(sql`delete from backup_policies where org_id = ${org.orgId}`);
    await dropScratchOrg(org.orgId);
  }
});
