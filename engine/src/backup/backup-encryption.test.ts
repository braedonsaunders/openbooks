import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, gunzipSync, gzipSync } from "node:zlib";
import { beginEncryptedBackup, requireBackupDataKey } from "./backup.ts";
import { inspectBackupArchive, peekBackupArchiveKind } from "./restore.ts";
import {
  BACKUP_DATA_KEY_CHECK_PLAINTEXT,
  BACKUP_FORMAT_VERSION,
  BACKUP_KEY_ID,
  decodeBackupEnvelopeLine,
} from "./format.ts";
import { sealSecret } from "../platform/secrets.ts";

// The shared suites provide a data key; the single-file loop may not.
process.env.OPENBOOKS_DATA_KEY ??=
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

async function withDataKey<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.OPENBOOKS_DATA_KEY;
  try {
    if (value === undefined) delete process.env.OPENBOOKS_DATA_KEY;
    else process.env.OPENBOOKS_DATA_KEY = value;
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.OPENBOOKS_DATA_KEY;
    else process.env.OPENBOOKS_DATA_KEY = prev;
  }
}

/** Encrypt NDJSON lines with the exact pipeline the backup writers use. */
async function writeEncryptedArchive(path: string, lines: string[]): Promise<{ sha256: string; envelopeLine: string }> {
  const encrypted = beginEncryptedBackup();
  const hash = createHash("sha256");
  hash.update(encrypted.envelopeLine);
  const gzip = createGzip({ level: 6 });
  const hasher = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  const out = createWriteStream(path, { mode: 0o600 });
  out.write(encrypted.envelopeLine);
  const done = pipeline(gzip, encrypted.cipher, encrypted.trailer, hasher, out);
  done.catch(() => {});
  gzip.end(`${lines.join("\n")}\n`);
  await done;
  return { sha256: hash.digest("hex"), envelopeLine: encrypted.envelopeLine };
}

function backupLines(orgId: string): string[] {
  const amount = "900719925474099312345.1234";
  return [
    JSON.stringify({
      format: "openbooks-backup",
      version: BACKUP_FORMAT_VERSION,
      orgId,
      createdAt: "2026-08-04T12:00:00.000Z",
      schemaSha256: "a".repeat(64),
      dataKeyCheck: sealSecret(BACKUP_DATA_KEY_CHECK_PLAINTEXT),
    }),
    `{"t":"orgs","r":{"id":"${orgId}","name":"Round Trip"}}`,
    `{"t":"journal_lines","r":{"id":"${randomUUID()}","org_id":"${orgId}","amount":${amount}}}`,
    `{"t":"journal_lines","r":{"id":"${randomUUID()}","org_id":"${orgId}","amount":1}}`,
    JSON.stringify({
      meta: {
        tables: [
          { name: "journal_lines", rows: 2 },
          { name: "orgs", rows: 1 },
        ],
        totalRows: 3,
        completedAt: "2026-08-04T12:00:01.000Z",
      },
    }),
  ];
}

test("encrypted backup round-trips with row counts equal per table", async () => {
  const orgId = randomUUID();
  const root = await mkdtemp(join(tmpdir(), "openbooks-backup-encrypted-"));
  try {
    const archive = join(root, "backup.json.gz");
    const { sha256 } = await writeEncryptedArchive(archive, backupLines(orgId));
    const inspected = await inspectBackupArchive({
      archivePath: archive,
      expectedSha256: sha256,
      expectedOrgId: orgId,
      spoolDir: join(root, "spool"),
    });
    assert.equal(inspected.encrypted, true);
    assert.equal(inspected.totalRows, 3);
    assert.deepEqual(inspected.tables, [
      { name: "journal_lines", rows: 2 },
      { name: "orgs", rows: 1 },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("encrypted backup bytes are opaque and carry a versioned envelope", async () => {
  const orgId = randomUUID();
  const root = await mkdtemp(join(tmpdir(), "openbooks-backup-encrypted-"));
  try {
    const archive = join(root, "backup.json.gz");
    const { envelopeLine } = await writeEncryptedArchive(archive, backupLines(orgId));
    const envelope = decodeBackupEnvelopeLine(envelopeLine);
    assert.equal(envelope?.version, BACKUP_FORMAT_VERSION);
    assert.equal(envelope?.keyId, BACKUP_KEY_ID);
    assert.ok(envelope!.nonce.length > 0);
    assert.ok(envelope!.wrappedKey.startsWith("enc:v1:"));
    // No gzip member survives: the file is not readable by zcat.
    assert.throws(() => gunzipSync(readFileSync(archive)));
    const kind = await peekBackupArchiveKind(archive);
    assert.deepEqual(kind, { encrypted: true, version: BACKUP_FORMAT_VERSION });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one tampered ciphertext byte refuses by name", async () => {
  const orgId = randomUUID();
  const root = await mkdtemp(join(tmpdir(), "openbooks-backup-encrypted-"));
  try {
    const archive = join(root, "backup.json.gz");
    const { envelopeLine } = await writeEncryptedArchive(archive, backupLines(orgId));
    const bytes = Buffer.from(await readFile(archive));
    bytes[envelopeLine.length + 10]! ^= 0x01;
    await writeFile(archive, bytes);
    const tamperedSha256 = createHash("sha256").update(bytes).digest("hex");
    await assert.rejects(
      inspectBackupArchive({
        archivePath: archive,
        expectedSha256: tamperedSha256,
        expectedOrgId: orgId,
        spoolDir: join(root, "spool"),
      }),
      /backup authentication failed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("peek names a legacy plaintext archive as unencrypted", async () => {
  const orgId = randomUUID();
  const root = await mkdtemp(join(tmpdir(), "openbooks-backup-encrypted-"));
  try {
    const archive = join(root, "legacy.json.gz");
    await writeFile(
      archive,
      gzipSync(
        `${JSON.stringify({ format: "openbooks-backup", version: 2, orgId, createdAt: "2026-08-04T12:00:00.000Z", schemaSha256: "c".repeat(64) })}\n` +
          `{"t":"orgs","r":{"id":"${orgId}"}}\n` +
          `${JSON.stringify({ meta: { tables: [{ name: "orgs", rows: 1 }], totalRows: 1 } })}\n`,
      ),
    );
    assert.deepEqual(await peekBackupArchiveKind(archive), { encrypted: false, version: 2 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("backup refuses an unset or placeholder data key, naming the remedy", async () => {
  await withDataKey(undefined, async () => {
    assert.throws(() => requireBackupDataKey(), /OPENBOOKS_DATA_KEY is unset.*secret manager/);
    assert.throws(() => beginEncryptedBackup(), /OPENBOOKS_DATA_KEY is unset/);
  });
  await withDataKey("replace-me", async () => {
    assert.throws(() => requireBackupDataKey(), /still the \.env\.example placeholder/);
  });
});
