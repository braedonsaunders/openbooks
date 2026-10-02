/** Select a verified release cut while retaining immutable historical SQL. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { baselineDigest } from "./migration-baseline-catalog.mjs";

export function validateBaselineManifest(manifest, directory) {
  if (manifest?.format !== 1 || manifest.verified !== true
      || !/^baselines\/[a-z0-9_]+\.sql$/.test(manifest.filename ?? "")
      || !/^[a-f0-9]{64}$/.test(manifest.baselineSha256 ?? "")
      || !/^[a-f0-9]{64}$/.test(manifest.catalogSha256 ?? "")
      || !Array.isArray(manifest.covered) || manifest.covered.length === 0) {
    throw new Error("release baseline manifest is malformed; prepare a verified migration baseline before activating it");
  }
  let previous = 0;
  for (const entry of manifest.covered) {
    const ordinal = /^generated\/(\d{4})_[a-z0-9_]+\.sql$/.exec(entry.filename ?? "");
    if (!ordinal || Number(ordinal[1]) <= previous || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? "")) throw new Error("release baseline coverage must contain unique ordered migration identities");
    previous = Number(ordinal[1]);
    if (baselineDigest(readFileSync(join(directory, entry.filename))) !== entry.sha256) throw new Error(`covered migration changed: ${entry.filename}; regenerate the release baseline on the final migration tree`);
  }
  if (manifest.covered[0].filename !== "generated/0001_baseline.sql") throw new Error("release baseline coverage must include the historical root baseline");
  if (baselineDigest(readFileSync(join(directory, manifest.filename))) !== manifest.baselineSha256) throw new Error("release baseline bytes differ from their verified digest");
  return previous;
}

export function releaseMigrationPlan(directory, generated) {
  const path = join(directory, "baseline.json");
  if (!existsSync(path)) return { baseline: null, filenames: generated.map((name) => `generated/${name}`) };
  const baseline = JSON.parse(readFileSync(path, "utf8"));
  const cutoff = validateBaselineManifest(baseline, directory);
  const covered = new Set(baseline.covered.map((entry) => entry.filename));
  for (const file of generated) {
    if (Number(file.slice(0, 4)) <= cutoff && !covered.has(`generated/${file}`)) throw new Error(`migration ${file} falls inside the release cut without verified coverage; regenerate the baseline`);
  }
  return { baseline, filenames: [baseline.filename, ...generated.filter((file) => Number(file.slice(0, 4)) > cutoff).map((file) => `generated/${file}`)] };
}

export function assertBaselineHistory(baseline, recorded, applicationTablesPresent) {
  if (!baseline) return;
  const row = recorded.find((entry) => entry.filename === baseline.filename);
  if (row?.sha256 === baseline.baselineSha256) return;
  if (!row && recorded.length === 0 && !applicationTablesPresent) return;
  throw new Error(`database has not adopted ${baseline.filename} at its verified digest; upgrade or reconcile the existing schema, then run scripts/adopt-migration-baseline.mts --check and --apply as described in docs/operations/migration-baseline-cutover.md. No baseline SQL may be replayed over tenant data.`);
}

/** Application-side upgrade work follows effective coverage after a squash. */
export function migrationIdentityIsApplied(filename, recorded, baseline) {
  if (recorded.some((entry) => entry.filename === filename)) return true;
  return Boolean(baseline?.covered.some((entry) => entry.filename === filename)
    && recorded.some((entry) => entry.filename === baseline.filename && entry.sha256 === baseline.baselineSha256));
}
