import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SftpBackend } from "./backend.ts";

// The archive selector resolves local storage through the engine env
// snapshot: hand it a throwaway directory before importing anything.
const scratchDataDir = mkdtempSync(join(tmpdir(), "openbooks-sftp-archive-"));
const { env } = await import("../platform/db.ts");
env.OPENBOOKS_DATA_DIR = scratchDataDir;

const { archiveConsumedFile, archiveDestination } = await import("./import-job.ts");
const { backendFor, s3Backend, setSftpS3ClientForTests } = await import("./backend.ts");
const { createFakeS3 } = await import("./fake-s3.ts");

const ORG = "66666666-6666-6666-6666-666666666666";
const ROOT = `sftp/${ORG}/archive`;
const BUCKET = "openbooks";

test.after(() => {
  setSftpS3ClientForTests(null);
  rmSync(scratchDataDir, { recursive: true, force: true });
});

function localBackend(): SftpBackend {
  return backendFor({ orgId: ORG, backend: "local", bucket: null, rootPrefix: ROOT });
}

function s3BackendOverFake(): { backend: SftpBackend; objects: Map<string, { bytes: Buffer }> } {
  const fake = createFakeS3();
  setSftpS3ClientForTests(fake.client);
  return { backend: s3Backend(BUCKET, ROOT, ORG), objects: fake.objects as Map<string, { bytes: Buffer }> };
}

test("archive destinations are dated, content-hashed generations", () => {
  const first = archiveDestination("inbound", "statement.ofx", Buffer.from("day-one"), "2026-09-23");
  assert.match(first, /^inbound\/processed\/2026-09-23\/statement\.[0-9a-f]{12}\.ofx$/);
  // Same name, different bytes: a different generation — yesterday's archive
  // is never the destination again.
  const second = archiveDestination("inbound", "statement.ofx", Buffer.from("day-two"), "2026-09-23");
  assert.notEqual(second, first);
  assert.match(second, /^inbound\/processed\/2026-09-23\/statement\.[0-9a-f]{12}\.ofx$/);
  // Same bytes: the same first generation (the selector numbers it on demand).
  assert.equal(archiveDestination("inbound", "statement.ofx", Buffer.from("day-one"), "2026-09-23"), first);
  // Numbered generations keep stem, hash, and extension recognizable.
  assert.match(
    archiveDestination("inbound", "statement.ofx", Buffer.from("day-one"), "2026-09-23", 2),
    /^inbound\/processed\/2026-09-23\/statement\.[0-9a-f]{12}\.2\.ofx$/,
  );
  // Extensionless names hash the same way.
  assert.match(
    archiveDestination("inbound", "STATEMENT", Buffer.from("x"), "2026-09-23"),
    /^inbound\/processed\/2026-09-23\/STATEMENT\.[0-9a-f]{12}$/,
  );
});

/** Two same-named source files with distinct bytes must both survive archiving. */
async function consumesDistinctSameNamedFiles(backend: SftpBackend): Promise<void> {
  await backend.write("inbound/statement.ofx", Buffer.from("day-one"));
  const first = await archiveConsumedFile(backend, "inbound", "statement.ofx", Buffer.from("day-one"));
  await backend.rename("inbound/statement.ofx", first);

  await backend.write("inbound/statement.ofx", Buffer.from("day-two"));
  const second = await archiveConsumedFile(backend, "inbound", "statement.ofx", Buffer.from("day-two"));
  await backend.rename("inbound/statement.ofx", second);

  assert.notEqual(second, first, "distinct bytes must not archive onto the same generation");
  assert.equal((await backend.read(first)).toString("utf8"), "day-one");
  assert.equal((await backend.read(second)).toString("utf8"), "day-two");
}

/** Re-importing identical bytes numbers a new generation instead of replacing. */
async function reimportKeepsBothGenerations(backend: SftpBackend): Promise<void> {
  await backend.write("inbound/replay.ofx", Buffer.from("same-bytes"));
  const first = await archiveConsumedFile(backend, "inbound", "replay.ofx", Buffer.from("same-bytes"));
  await backend.rename("inbound/replay.ofx", first);

  await backend.write("inbound/replay.ofx", Buffer.from("same-bytes"));
  const second = await archiveConsumedFile(backend, "inbound", "replay.ofx", Buffer.from("same-bytes"));
  await backend.rename("inbound/replay.ofx", second);

  assert.notEqual(second, first);
  assert.match(second, /\.2\.ofx$/);
  assert.equal((await backend.read(first)).toString("utf8"), "same-bytes");
  assert.equal((await backend.read(second)).toString("utf8"), "same-bytes");
}

test("local disk keeps every same-named generation without overwrite", async () => {
  await consumesDistinctSameNamedFiles(localBackend());
  await reimportKeepsBothGenerations(localBackend());
});

test("object storage keeps every same-named generation without overwrite", async () => {
  const { backend } = s3BackendOverFake();
  await consumesDistinctSameNamedFiles(backend);
  await reimportKeepsBothGenerations(backend);
});
