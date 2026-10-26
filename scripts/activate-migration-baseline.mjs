/** Publish a prepared cut and retire the migration inputs it replaces. */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { baselineDigest } from "./migration-baseline-catalog.mjs";
import { validateBaselineManifest } from "./migration-baseline-plan.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const usage =
  "usage: node scripts/activate-migration-baseline.mjs <candidate-directory> <release-name> --upgrade-from <previous-release-tag>";
const [candidate, name, flag, upgradeFromRelease, ...extra] = process.argv.slice(2);
if (
  !candidate ||
  !/^[a-z0-9_]+$/.test(name ?? "") ||
  flag !== "--upgrade-from" ||
  !upgradeFromRelease ||
  extra.length
)
  throw new Error(usage);
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const directory = join(root, "schema/migrations");
if (git("status", "--porcelain", "--", "schema/migrations").trim())
  throw new Error(
    "migration changes are still uncommitted; land them and regenerate the baseline before activating the release cut",
  );
const manifest = JSON.parse(readFileSync(join(candidate, "manifest.json"), "utf8"));
if (manifest.format !== 2 || manifest.sourceStatus?.trim())
  throw new Error("candidate was not verified on a committed migration tree; regenerate it");
// Evidence identifies the migration inputs, not unrelated code: the cut may be
// activated on a descendant whose migration tree is byte-identical.
try {
  git("merge-base", "--is-ancestor", manifest.sourceCommit, "HEAD");
} catch {
  throw new Error(
    "candidate was prepared on a commit this tree does not descend from; regenerate it",
  );
}
if (git("diff", "--name-only", manifest.sourceCommit, "HEAD", "--", "schema/migrations").trim())
  throw new Error(
    "migration inputs changed after the candidate was verified; regenerate it on the final release tree",
  );
const baseline = readFileSync(join(candidate, "baseline.sql"));
const catalog = JSON.parse(readFileSync(join(candidate, "replay-catalog.json"), "utf8"));
if (
  baselineDigest(baseline) !== manifest.baselineSha256 ||
  baselineDigest(JSON.stringify(catalog)) !== manifest.catalogSha256
)
  throw new Error("candidate SQL or catalog evidence differs from its verified manifest");
if (
  baselineDigest(readFileSync(join(directory, "environments.sql"))) !== manifest.environmentSha256
)
  throw new Error("environment policy inputs changed after verification; regenerate the baseline");

// The previous release must be exactly the ledger installations hold before
// adoption: every migration it ships is covered, and its plan is upgradeFrom.
const released = git(
  "ls-tree",
  "-r",
  "--name-only",
  upgradeFromRelease,
  "--",
  "schema/migrations/generated/",
)
  .split("\n")
  .filter((path) => path.endsWith(".sql"))
  .map((path) => path.slice("schema/migrations/".length));
const covered = new Map(manifest.covered.map((entry) => [entry.filename, entry.sha256]));
const uncovered = released.filter((filename) => !covered.has(filename));
if (uncovered.length)
  throw new Error(
    `${upgradeFromRelease} ships migrations the candidate does not cover: ${uncovered.join(", ")}`,
  );
for (const entry of manifest.upgradeFrom) {
  const bytes = execFileSync(
    "git",
    ["show", `${upgradeFromRelease}:schema/migrations/${entry.filename}`],
    { cwd: root, maxBuffer: 256 * 1024 * 1024 },
  );
  if (baselineDigest(bytes) !== entry.sha256)
    throw new Error(
      `${entry.filename} differs from ${upgradeFromRelease}; the candidate's upgrade ledger is not that release`,
    );
}
const current = JSON.parse(readFileSync(join(directory, "baseline.json"), "utf8"));
for (const entry of manifest.upgradeFrom) {
  if (
    entry.filename === current.filename
      ? entry.sha256 !== current.baselineSha256
      : baselineDigest(readFileSync(join(directory, entry.filename))) !== entry.sha256
  )
    throw new Error(`candidate input changed: ${entry.filename}`);
}

const activated = { ...manifest, filename: `baselines/${name}.sql`, upgradeFromRelease };
mkdirSync(join(directory, "baselines"), { recursive: true });
writeFileSync(join(directory, activated.filename), baseline, { flag: "wx" });
validateBaselineManifest(activated, directory);
writeFileSync(
  join(directory, `${activated.filename}.catalog.json`),
  JSON.stringify(catalog, null, 2) + "\n",
  { flag: "wx" },
);

// Retire the replaced inputs. Their identities and digests remain in the
// manifest; installations adopt the baseline rather than replay them.
const retired = [];
for (const filename of covered.keys()) {
  for (const path of filename === current.filename
    ? [filename, `${filename}.catalog.json`, `${filename}.environments.sql`]
    : [filename]) {
    if (existsSync(join(directory, path))) {
      rmSync(join(directory, path));
      retired.push(path);
    }
  }
  const basename = filename.replace(/^generated\//, "").replace(/\.sql$/, "");
  for (const decision of [`${basename}.sql`, `${basename}.none`]) {
    const path = join(directory, "preflight", decision);
    if (existsSync(path)) {
      rmSync(path);
      retired.push(`preflight/${decision}`);
    }
  }
}
const preflights = existsSync(join(directory, "preflight"))
  ? readdirSync(join(directory, "preflight"))
      .filter((file) => /\.(?:sql|none)$/.test(file))
      .map((file) => readFileSync(join(directory, "preflight", file), "utf8"))
  : [];
const remedies = join(directory, "preflight", "remedies");
if (existsSync(remedies)) {
  for (const remedy of readdirSync(remedies)) {
    if (preflights.some((text) => text.includes(remedy.replace(/\.sql$/, "")))) continue;
    rmSync(join(remedies, remedy));
    retired.push(`preflight/remedies/${remedy}`);
  }
}
const prerequisites = join(directory, "prerequisites.json");
if (existsSync(prerequisites)) {
  const parsed = JSON.parse(readFileSync(prerequisites, "utf8"));
  parsed.dependencies = parsed.dependencies.filter((entry) => !covered.has(entry.migration));
  writeFileSync(prerequisites, JSON.stringify(parsed, null, 2) + "\n");
}
writeFileSync(join(directory, "baseline.json.pending"), JSON.stringify(activated, null, 2) + "\n", {
  flag: "wx",
});
renameSync(join(directory, "baseline.json.pending"), join(directory, "baseline.json"));
console.log(
  `activated ${activated.filename}; retired ${retired.length} replaced migration inputs covering ${covered.size} historical identities; installations upgrade from ${upgradeFromRelease}`,
);
