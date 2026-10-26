/** Select the verified release baseline and the forward migrations above it. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { baselineDigest } from "./migration-baseline-catalog.mjs";

const FORWARD_IDENTITY = /^generated\/\d{4}_[a-z0-9_]+\.sql$/;
const HISTORICAL_IDENTITY = /^(?:generated\/\d{4}_[a-z0-9_]+|baselines\/[a-z0-9_]+)\.sql$/;
const SHA256 = /^[a-f0-9]{64}$/;

/** Explicit schema prerequisites can outlive ordinal allocation order. Keep
 * immutable SQL identities and otherwise retain the existing release order. */
export function orderMigrationPrerequisites(directory, filenames) {
  const path = join(directory, "prerequisites.json");
  if (!existsSync(path)) return filenames;
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (
    manifest?.format !== 1 ||
    !Array.isArray(manifest.dependencies) ||
    Object.keys(manifest).some((key) => !["format", "dependencies"].includes(key))
  ) {
    throw new Error("migration prerequisite manifest is malformed");
  }
  const included = new Set(filenames);
  if (included.size !== filenames.length)
    throw new Error("duplicate migration identity in release plan");
  const requirements = new Map(filenames.map((filename) => [filename, new Set()]));
  const declared = new Set();
  for (const entry of manifest.dependencies) {
    if (
      !FORWARD_IDENTITY.test(entry?.migration ?? "") ||
      !Array.isArray(entry.requires) ||
      !entry.requires.length ||
      Object.keys(entry).some((key) => !["migration", "requires"].includes(key)) ||
      declared.has(entry.migration) ||
      new Set(entry.requires).size !== entry.requires.length ||
      entry.requires.some(
        (filename) => !FORWARD_IDENTITY.test(filename) || filename === entry.migration,
      )
    ) {
      throw new Error("migration prerequisites require unique exact migration identities");
    }
    declared.add(entry.migration);
    // A selected release may intentionally exclude an unpublished migration.
    if (!included.has(entry.migration)) continue;
    for (const prerequisite of entry.requires) {
      if (!included.has(prerequisite))
        throw new Error(`${entry.migration} requires missing migration ${prerequisite}`);
      requirements.get(entry.migration).add(prerequisite);
    }
  }
  const remaining = new Set(filenames);
  const ordered = [];
  while (remaining.size) {
    const next = filenames.find(
      (filename) =>
        remaining.has(filename) &&
        [...requirements.get(filename)].every((prerequisite) => !remaining.has(prerequisite)),
    );
    if (!next)
      throw new Error(`migration prerequisites contain a cycle: ${[...remaining].join(", ")}`);
    remaining.delete(next);
    ordered.push(next);
  }
  return ordered;
}

function validIdentities(entries) {
  return (
    Array.isArray(entries) &&
    entries.length > 0 &&
    entries.every(
      (entry) =>
        HISTORICAL_IDENTITY.test(entry?.filename ?? "") &&
        SHA256.test(entry.sha256 ?? "") &&
        Object.keys(entry).every((key) => key === "filename" || key === "sha256"),
    ) &&
    new Set(entries.map((entry) => entry.filename)).size === entries.length
  );
}

/**
 * A release baseline replaces every earlier migration identity. `covered`
 * lists each identity it subsumes; `upgradeFrom` is the exact ledger of the
 * previous release, which an existing installation must hold before it may
 * adopt this baseline. Neither requires the retired source files.
 */
export function validateBaselineManifest(manifest, directory) {
  if (
    manifest?.format !== 2 ||
    manifest.verified !== true ||
    !/^baselines\/[a-z0-9_]+\.sql$/.test(manifest.filename ?? "") ||
    !SHA256.test(manifest.baselineSha256 ?? "") ||
    !SHA256.test(manifest.catalogSha256 ?? "") ||
    !/^v\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/.test(manifest.upgradeFromRelease ?? "") ||
    !validIdentities(manifest.covered) ||
    !validIdentities(manifest.upgradeFrom)
  ) {
    throw new Error(
      "release baseline manifest is malformed; prepare and activate a verified migration baseline",
    );
  }
  const covered = new Map(manifest.covered.map((entry) => [entry.filename, entry.sha256]));
  if (covered.has(manifest.filename))
    throw new Error("release baseline cannot cover its own identity");
  if (manifest.upgradeFrom.some((entry) => covered.get(entry.filename) !== entry.sha256)) {
    throw new Error("release baseline upgrade ledger must be covered at its recorded digests");
  }
  if (baselineDigest(readFileSync(join(directory, manifest.filename))) !== manifest.baselineSha256)
    throw new Error("release baseline bytes differ from their verified digest");
}

export function releaseMigrationPlan(directory, generated) {
  const forward = generated.map((file) => `generated/${file}`);
  const path = join(directory, "baseline.json");
  if (!existsSync(path))
    return { baseline: null, filenames: orderMigrationPrerequisites(directory, forward) };
  const baseline = JSON.parse(readFileSync(path, "utf8"));
  validateBaselineManifest(baseline, directory);
  const covered = new Set(baseline.covered.map((entry) => entry.filename));
  for (const filename of forward) {
    // An installation that adopted the baseline may still record this name
    // from its previous release; reusing it would read as already applied.
    if (covered.has(filename))
      throw new Error(
        `migration ${filename} reuses an identity ${baseline.filename} covers; give it a new name`,
      );
  }
  return {
    baseline,
    filenames: [baseline.filename, ...orderMigrationPrerequisites(directory, forward)],
  };
}

/** Previous-release ledger identities this installation lacks or holds at another digest. */
export function missingUpgradeLedger(baseline, recorded) {
  const digests = new Map(recorded.map((entry) => [entry.filename, entry.sha256]));
  return baseline.upgradeFrom
    .filter((entry) => digests.get(entry.filename) !== entry.sha256)
    .map((entry) => entry.filename);
}

export function assertBaselineHistory(baseline, recorded, applicationTablesPresent) {
  if (!baseline) return;
  const row = recorded.find((entry) => entry.filename === baseline.filename);
  if (row?.sha256 === baseline.baselineSha256) return;
  if (row)
    throw new Error(
      `database records ${baseline.filename} at another digest; preserve the installation and investigate its migration ledger`,
    );
  if (recorded.length === 0 && !applicationTablesPresent) return;
  throw new Error(
    `database has not adopted ${baseline.filename}. Upgrade it with ${baseline.upgradeFromRelease} first, then run scripts/adopt-migration-baseline.mts --check and --apply as described in docs/operations/migration-baseline-cutover.md. No baseline SQL may be replayed over tenant data.`,
  );
}

/** Application-side upgrade work follows effective coverage after a squash. */
export function migrationIdentityIsApplied(filename, recorded, baseline) {
  if (recorded.some((entry) => entry.filename === filename)) return true;
  return Boolean(
    baseline?.covered.some((entry) => entry.filename === filename) &&
    recorded.some(
      (entry) => entry.filename === baseline.filename && entry.sha256 === baseline.baselineSha256,
    ),
  );
}
