import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { inspectBackupArchive } from "./backup-restore.ts";

async function fixture(lines: string[]): Promise<{
  root: string;
  archive: string;
  spool: string;
  sha256: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "openbooks-restore-unit-"));
  const archive = join(root, "backup.json.gz");
  const bytes = gzipSync(`${lines.join("\n")}\n`);
  await writeFile(archive, bytes, { mode: 0o600 });
  return {
    root,
    archive,
    spool: join(root, "spool"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

test("archive inspection authenticates counts and preserves numeric row JSON verbatim", async () => {
  const orgId = randomUUID();
  const amount = "900719925474099312345.1234";
  const f = await fixture([
    JSON.stringify({
      format: "openbooks-backup",
      version: 2,
      orgId,
      createdAt: "2026-08-04T12:00:00.000Z",
      schemaSha256: "a".repeat(64),
    }),
    `{"t":"orgs","r":{"id":"${orgId}","name":"Restore Drill"}}`,
    `{"t":"journal_lines","r":{"id":"${randomUUID()}","org_id":"${orgId}","amount":${amount}}}`,
    JSON.stringify({
      meta: {
        tables: [
          { name: "orgs", rows: 1 },
          { name: "journal_lines", rows: 1 },
          { name: "accounts", rows: 0 },
        ],
        totalRows: 2,
        completedAt: "2026-08-04T12:00:01.000Z",
      },
    }),
  ]);
  try {
    const inspected = await inspectBackupArchive({
      archivePath: f.archive,
      expectedSha256: f.sha256,
      expectedOrgId: orgId,
      spoolDir: f.spool,
    });
    assert.equal(inspected.totalRows, 2);
    assert.equal(inspected.tables.length, 3);
    assert.match(await readFile(join(f.spool, "journal_lines.ndjson"), "utf8"), new RegExp(amount.replace(".", "\\.")));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("archive inspection rejects a tenant-boundary violation before database access", async () => {
  const orgId = randomUUID();
  const f = await fixture([
    JSON.stringify({
      format: "openbooks-backup",
      version: 2,
      orgId,
      createdAt: "2026-08-04T12:00:00.000Z",
      schemaSha256: "b".repeat(64),
    }),
    `{"t":"orgs","r":{"id":"${orgId}"}}`,
    `{"t":"accounts","r":{"id":"${randomUUID()}","org_id":"${randomUUID()}"}}`,
    JSON.stringify({ meta: { tables: [{ name: "orgs", rows: 1 }, { name: "accounts", rows: 1 }], totalRows: 2 } }),
  ]);
  try {
    await assert.rejects(
      inspectBackupArchive({
        archivePath: f.archive,
        expectedSha256: f.sha256,
        expectedOrgId: orgId,
        spoolDir: f.spool,
      }),
      /crosses the organization boundary/,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("format-v1 archives require an explicit schema-risk override", async () => {
  const orgId = randomUUID();
  const f = await fixture([
    JSON.stringify({ format: "openbooks-backup", version: 1, orgId, createdAt: "2026-08-04T12:00:00.000Z" }),
    `{"t":"orgs","r":{"id":"${orgId}"}}`,
    JSON.stringify({ meta: { tables: [{ name: "orgs", rows: 1 }], totalRows: 1 } }),
  ]);
  try {
    await assert.rejects(
      inspectBackupArchive({
        archivePath: f.archive,
        expectedSha256: f.sha256,
        expectedOrgId: orgId,
        spoolDir: f.spool,
      }),
      /legacy format-v1 backup has no schema fingerprint/,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("archive inspection rejects a checksum mismatch before decompression", async () => {
  const orgId = randomUUID();
  const f = await fixture(["not even a gzip payload after authentication"]);
  try {
    await assert.rejects(
      inspectBackupArchive({
        archivePath: f.archive,
        expectedSha256: "0".repeat(64),
        expectedOrgId: orgId,
        spoolDir: f.spool,
      }),
      /backup SHA-256 mismatch/,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
