/**
 * Offline organization-restore CLI.
 *
 * The target must have the exact source schema and zero organizations. Build
 * it with OPENBOOKS_RESTORE_TARGET=1 bootstrap; keep web and workers stopped.
 * The dedicated restore URL is intentionally not allowed to fall back to the
 * application's constrained runtime URL.
 *
 * Usage:
 *   OPENBOOKS_RESTORE_DB_URL=postgres://... npx tsx src/backup-restore-cli.ts \
 *     --in=/secure/acme-backup.json.gz \
 *     --manifest=/secure/acme-backup.json.gz.manifest.json \
 *     --org=<uuid> --confirm-empty-target=<same-uuid> \
 *     --report=/secure/acme-restore-report.json
 *
 * Add --reset-mfa only for an approved factor-revocation/re-enrollment event.
 * It never bypasses the source OPENBOOKS_DATA_KEY requirement.
 */
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { restoreOrgBackup, readLocalBackupManifest } from "./backup-restore.ts";

const args = new Map(
  process.argv
    .slice(2)
    .filter((value) => value.startsWith("--"))
    .map((value) => {
      const [key, ...rest] = value.slice(2).split("=");
      return [key!, rest.length ? rest.join("=") : "true"];
    }),
);
const input = args.get("in");
const manifestPath = args.get("manifest");
const suppliedSha256 = args.get("sha256");
const expectedOrgId = args.get("org");
const reportPath = args.get("report");
const connectionString = process.env.OPENBOOKS_RESTORE_DB_URL;

if (!input?.startsWith("/")) throw new Error("--in=<absolute-path> is required");
if (manifestPath && !manifestPath.startsWith("/")) throw new Error("--manifest must be an absolute path");
if ((!manifestPath && !suppliedSha256) || (manifestPath && suppliedSha256)) {
  throw new Error("provide exactly one of --manifest=<absolute-path> or --sha256=<stored-backup-sha256>");
}
if (!reportPath?.startsWith("/")) throw new Error("--report=<absolute-path> is required");
if (!expectedOrgId) throw new Error("--org=<uuid> is required");
if (args.get("confirm-empty-target") !== expectedOrgId) {
  throw new Error("--confirm-empty-target=<org-uuid> must exactly match --org; restore also refuses databases containing any organization");
}
if (!connectionString) {
  throw new Error("OPENBOOKS_RESTORE_DB_URL is required and must identify the controlled schema-owner restore connection");
}
if (existsSync(reportPath)) throw new Error(`refusing to overwrite restore report ${reportPath}`);

const manifest = manifestPath ? await readLocalBackupManifest(manifestPath) : null;
if (manifest && manifest.orgId !== expectedOrgId) {
  throw new Error(`manifest organization ${manifest.orgId} does not match --org ${expectedOrgId}`);
}
const report = await restoreOrgBackup({
  archivePath: input,
  expectedSha256: manifest?.sha256 ?? suppliedSha256!,
  expectedOrgId,
  connectionString,
  expectedRowCount: manifest?.rowCount,
  expectedTableCount: manifest?.tableCount,
  allowLegacyV1: args.has("allow-legacy-v1"),
  allowLegacyV2WithoutKeyCheck: args.has("allow-legacy-v2-without-key-check"),
  resetMfaFactors: args.has("reset-mfa"),
});
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o600,
  flag: "wx",
});
console.log(JSON.stringify(report));
