/** Publish a prepared cut only when the final committed migration inputs match. */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { baselineDigest } from "./migration-baseline-catalog.mjs";
import { validateBaselineManifest } from "./migration-baseline-plan.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [candidate, name, ...extra] = process.argv.slice(2);
if (!candidate || !/^[a-z0-9_]+$/.test(name ?? "") || extra.length) throw new Error("usage: node scripts/activate-migration-baseline.mjs <candidate-directory> <release-name>");
const directory = join(root, "schema/migrations");
const status = execFileSync("git", ["status", "--porcelain", "--", "schema/migrations"], { cwd: root, encoding: "utf8" });
if (status.trim()) throw new Error("migration changes are still uncommitted; land them and regenerate the baseline before activating the release cut");
const manifest = JSON.parse(readFileSync(join(candidate, "manifest.json"), "utf8"));
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
if (manifest.sourceCommit !== head || manifest.sourceStatus?.trim()) throw new Error("candidate was not verified on this final committed tree; regenerate it before activation");
const baseline = readFileSync(join(candidate, "0001_baseline.sql"));
const catalog = JSON.parse(readFileSync(join(candidate, "replay-catalog.json"), "utf8"));
if (baselineDigest(baseline) !== manifest.baselineSha256 || baselineDigest(JSON.stringify(catalog)) !== manifest.catalogSha256) throw new Error("candidate SQL or catalog evidence differs from its verified manifest");
if (baselineDigest(readFileSync(join(directory, "environments.sql"))) !== manifest.environmentSha256) throw new Error("environment policy inputs changed after verification; regenerate the baseline");
manifest.filename = `baselines/${name}.sql`;
// Refuse before creating release artifacts if any covered input drifted.
for (const entry of manifest.covered ?? []) {
  if (baselineDigest(readFileSync(join(directory, entry.filename))) !== entry.sha256) throw new Error(`candidate input changed: ${entry.filename}`);
}
mkdirSync(join(directory, "baselines"), { recursive: true });
writeFileSync(join(directory, manifest.filename), baseline, { flag: "wx" });
validateBaselineManifest(manifest, directory);
writeFileSync(join(directory, `${manifest.filename}.catalog.json`), JSON.stringify(catalog, null, 2) + "\n", { flag: "wx" });
// Historical replays reproduce the baseline under the policy environment it was verified with.
writeFileSync(join(directory, `${manifest.filename}.environments.sql`), readFileSync(join(directory, "environments.sql")), { flag: "wx" });
writeFileSync(join(directory, "baseline.json.pending"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
renameSync(join(directory, "baseline.json.pending"), join(directory, "baseline.json"));
console.log(`activated ${manifest.filename}; ${manifest.covered.length} historical migrations remain immutable and are excluded from fresh-install replay`);
