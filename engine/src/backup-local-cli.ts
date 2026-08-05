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
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { streamOrgBackup } from "./backup.ts";
import { BACKUP_FORMAT_VERSION } from "./backup-format.ts";

const args = new Map(
  process.argv
    .slice(2)
    .filter((arg) => arg.startsWith("--"))
    .map((arg) => {
      const [key, ...value] = arg.slice(2).split("=");
      return [key!, value.join("=")];
    }),
);
const orgId = args.get("org");
const out = args.get("out");

if (!orgId || !/^[0-9a-f-]{36}$/i.test(orgId)) {
  throw new Error("--org=<uuid> is required");
}
if (!out?.startsWith("/")) throw new Error("--out=<absolute-path> is required");
if (existsSync(out) || existsSync(`${out}.manifest.json`)) {
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

try {
  const completed = pipeline(gzip, hasher, createWriteStream(partial, { mode: 0o600 }));
  const stats = await streamOrgBackup(orgId, gzip);
  await completed;
  const sha256 = hash.digest("hex");
  const byteSize = (await stat(partial)).size;
  await rename(partial, out);

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
  await writeFile(
    `${out}.manifest.json`,
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  console.log(JSON.stringify(manifest));
} catch (error) {
  await rm(partial, { force: true });
  throw error;
}
