/**
 * Local organization backup CLI.
 *
 * Uses the same repeatable-read, precision-preserving export as stored S3
 * backups, but writes to an explicit local path for operator-controlled
 * maintenance windows where object storage is unavailable.
 *
 * Usage:
 *   npx tsx src/backup-local-cli.ts --org=<uuid> --out=/safe/path/backup.json.gz
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Transform, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { streamOrgBackup, type BackupExportStats } from "./backup.ts";
import { BACKUP_FORMAT_VERSION } from "./backup-format.ts";

type StreamBackup = (orgId: string, sink: Writable) => Promise<BackupExportStats>;
type WriteManifest = (path: string, contents: string) => Promise<void>;

export interface LocalBackupOptions {
  orgId?: string;
  out?: string;
  streamBackup?: StreamBackup;
  writeManifest?: WriteManifest;
}

function parseArgs(argv: readonly string[]): Map<string, string> {
  return new Map(
    argv
    .slice(2)
    .filter((arg) => arg.startsWith("--"))
    .map((arg) => {
      const [key, ...value] = arg.slice(2).split("=");
      return [key!, value.join("=")];
    }),
  );
}

const persistManifest: WriteManifest = (path, contents) =>
  writeFile(path, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });

/** Create and verify a local organization backup and its no-overwrite manifest. */
export async function runLocalBackup({
  orgId,
  out,
  streamBackup = streamOrgBackup,
  writeManifest = persistManifest,
}: LocalBackupOptions) {
  if (!orgId || !/^[0-9a-f-]{36}$/i.test(orgId)) {
    throw new Error("--org=<uuid> is required");
  }
  if (!out?.startsWith("/")) throw new Error("--out=<absolute-path> is required");
  const manifestPath = `${out}.manifest.json`;
  if (existsSync(out) || existsSync(manifestPath)) {
    throw new Error(`refusing to overwrite an existing backup: ${out}`);
  }

  await mkdir(dirname(out), { recursive: true, mode: 0o700 });
  const partial = `${out}.partial`;
  const hash = createHash("sha256");
  const gzip = createGzip({ level: 6 });
  const hasher = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  let archiveRenamed = false;
  let manifestWriteStarted = false;
  let manifestExistedBeforeWrite = false;

  try {
    const completed = pipeline(gzip, hasher, createWriteStream(partial, { mode: 0o600 }));
    const stats = await streamBackup(orgId, gzip);
    await completed;
    const sha256 = hash.digest("hex");
    const byteSize = (await stat(partial)).size;
    await rename(partial, out);
    archiveRenamed = true;

    // Verify the bytes after the atomic rename, not merely the stream in flight.
    const verifier = createHash("sha256");
    for await (const chunk of createReadStream(out)) verifier.update(chunk);
    const verifiedSha256 = verifier.digest("hex");
    if (verifiedSha256 !== sha256) {
      throw new Error("backup verification hash mismatch");
    }
    const manifest = {
      format: "openbooks-local-backup-manifest",
      version: 1,
      backupFormatVersion: BACKUP_FORMAT_VERSION,
      orgId,
      createdAt: new Date().toISOString(),
      file: out,
      byteSize,
      sha256,
      tableCount: stats.tables.length,
      rowCount: stats.totalRows,
      tables: stats.tables,
    };
    manifestExistedBeforeWrite = existsSync(manifestPath);
    manifestWriteStarted = true;
    await writeManifest(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(JSON.stringify(manifest));
    return manifest;
  } catch (error) {
    const artifacts = archiveRenamed
      ? [partial, out, ...(manifestWriteStarted && !manifestExistedBeforeWrite ? [manifestPath] : [])]
      : [partial];
    const cleanupErrors: unknown[] = [];
    for (const artifact of artifacts) {
      try {
        await rm(artifact, { force: true });
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], "local backup failed and artifact cleanup failed");
    }
    throw error;
  }
}

if (/backup-local-cli\.(?:[cm]?[jt]s)$/.test(process.argv[1] ?? "")) {
  const args = parseArgs(process.argv);
  runLocalBackup({ orgId: args.get("org"), out: args.get("out") }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
