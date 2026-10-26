#!/usr/bin/env node
/**
 * Plan the release-only upgrade rehearsal matrix.
 *
 * Reads rehearsal.json and emits one matrix cell per (source release, dataset).
 * The config is validated first, and this fails closed. A required dataset
 * class with no dataset, an unknown step kind, a malformed source tag, or a
 * source that cannot upgrade into the candidate's release baseline is refused
 * by name. A matrix that silently lost a class would still go green while
 * rehearsing less than the gate promises.
 *
 *   node scripts/upgrade-rehearsal/plan.mjs                  # print the matrix
 *   node scripts/upgrade-rehearsal/plan.mjs --default-only    # print the release default
 *   node scripts/upgrade-rehearsal/plan.mjs --github-output "$GITHUB_OUTPUT"
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const CONFIG_PATH = join(HERE, "rehearsal.json");

export const STEP_KINDS = Object.freeze(["sim", "samples", "seeder", "remedy"]);
const SIM_MODES = new Set(["run", "endurance"]);
const TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
const ID = /^[a-z0-9][a-z0-9-]*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const FINDING_CODE = /^\d{4}\.[a-z][a-z0-9_]*$/;
const SEVERITIES = new Set(["refuse", "notice"]);
/**
 * Remedy SQL files live next to the preflights, never in the rehearsal:
 * the rehearsal must prove the SAME remedy operators get. A remedy step
 * references its file by repo-relative path, and anything outside the
 * remedies directory is refused here.
 */
export const REMEDY_DIR_PREFIX = "schema/migrations/preflight/remedies/";
const SHA = /^[0-9a-f]{40}$/;
/**
 * The only source-tree paths a source-oracle overlay may replace. The oracle
 * lives in engine/src/golden/scenario.ts; engine/src/platform/uuid.ts is the
 * pure UUID predicate that oracle imports (no data writes, no schema).
 * Anything else — the posting kernel, migrations, seeders — shapes the seeded
 * rows, and overlaying it would rehearse an upgrade of data the source
 * release never wrote. Refused here, at plan time, not mid-cell.
 */
export const ORACLE_OVERLAY_ALLOWLIST = Object.freeze([
  "engine/src/golden/scenario.ts",
  "engine/src/platform/uuid.ts",
]);

/** The candidate's release baseline manifest; its identity decides which sources can upgrade. */
export const CANDIDATE_BASELINE_PATH = join(
  HERE,
  "..",
  "..",
  "schema",
  "migrations",
  "baseline.json",
);
const BASELINE_MANIFEST = "schema/migrations/baseline.json";

function refuse(problems, message) {
  problems.push(message);
}

function validateStep(step, where, problems) {
  if (!step || typeof step !== "object") return refuse(problems, `${where}: step is not an object`);
  if (!STEP_KINDS.includes(step.kind)) {
    return refuse(
      problems,
      `${where}: unknown step kind ${JSON.stringify(step.kind)} (known: ${STEP_KINDS.join(", ")})`,
    );
  }
  if (step.kind === "sim") {
    if (!SIM_MODES.has(step.mode)) refuse(problems, `${where}: sim mode must be run or endurance`);
    for (const key of ["profile", "seed"]) {
      if (typeof step[key] !== "string" || step[key].length === 0)
        refuse(problems, `${where}: sim step needs ${key}`);
    }
    for (const key of ["start", "end"]) {
      if (!DATE.test(step[key] ?? ""))
        refuse(problems, `${where}: sim step ${key} must be YYYY-MM-DD`);
    }
    if (DATE.test(step.start ?? "") && DATE.test(step.end ?? "") && step.start > step.end) {
      refuse(problems, `${where}: sim step starts after it ends`);
    }
  }
  if (step.kind === "seeder" && !ID.test(step.name ?? "")) {
    refuse(problems, `${where}: seeder step needs a kebab-case name`);
  }
  if (step.kind === "remedy") {
    validateRemedyStep(step, where, problems);
  }
}

function validateRemedyStep(step, where, problems) {
  const code = step?.code;
  if (!FINDING_CODE.test(code ?? "")) {
    refuse(problems, `${where}: remedy step needs a finding code like 0001.malformed_marker`);
  }
  const sql = (step?.sql ?? "").replace(/\\/g, "/");
  if (
    typeof step?.sql !== "string" ||
    !sql.startsWith(REMEDY_DIR_PREFIX) ||
    sql.includes("..") ||
    !sql.endsWith(".sql") ||
    sql.length <= REMEDY_DIR_PREFIX.length + ".sql".length
  ) {
    refuse(
      problems,
      `${where}: remedy sql must be a file under ${REMEDY_DIR_PREFIX} (the rehearsal carries no private remedies): got ${JSON.stringify(step?.sql)}`,
    );
    return;
  }
  const fileCode = sql.slice(REMEDY_DIR_PREFIX.length, -".sql".length);
  if (!FINDING_CODE.test(fileCode)) {
    refuse(
      problems,
      `${where}: remedy sql filename must be <finding-code>.sql: got ${JSON.stringify(step.sql)}`,
    );
    return;
  }
  if (code !== fileCode) {
    refuse(
      problems,
      `${where}: remedy code ${JSON.stringify(code)} does not match its file ${JSON.stringify(step.sql)}`,
    );
  }
}

function validateExpectFindings(dataset, where, problems) {
  const expected = dataset?.expectFindings;
  if (expected === undefined) return [];
  if (!Array.isArray(expected)) {
    refuse(problems, `${where}: expectFindings must be an array`);
    return [];
  }
  for (const [index, finding] of expected.entries()) {
    if (!FINDING_CODE.test(finding?.code ?? "")) {
      refuse(
        problems,
        `${where} expectFindings ${index}: code must look like <ordinal>.<snake_reason>`,
      );
    }
    if (!SEVERITIES.has(finding?.severity)) {
      refuse(problems, `${where} expectFindings ${index}: severity must be refuse or notice`);
    }
  }
  return expected;
}

/**
 * A frozen source release cannot seed a dataset its own oracle refuses to
 * finish (a defective tagged invariant halts the source sim mid-seed). The
 * dataset may declare a source-oracle overlay: the
 * fixed oracle file(s), copied from the candidate tree into the source tree
 * for the seed phase only and removed before the source-harness phase. The
 * sha names the covering commit for audit; the files are allow-listed to the
 * oracle so no data-shaping code can ride along.
 */
function validateSourceOracleOverlay(dataset, where, problems) {
  const overlay = dataset?.sourceOracleOverlay;
  if (overlay === undefined) return;
  if (!overlay || typeof overlay !== "object") {
    refuse(problems, `${where}: sourceOracleOverlay must be an object`);
    return;
  }
  if (!SHA.test(overlay.sha ?? "")) {
    refuse(problems, `${where}: sourceOracleOverlay needs the full covering commit sha`);
  }
  if (!Array.isArray(overlay.files) || overlay.files.length === 0) {
    refuse(problems, `${where}: sourceOracleOverlay needs a non-empty files array`);
  } else {
    for (const file of overlay.files) {
      const allowed =
        typeof file === "string" &&
        !file.includes("..") &&
        ORACLE_OVERLAY_ALLOWLIST.some((prefix) =>
          prefix.endsWith("/") ? file.startsWith(prefix) : file === prefix,
        );
      if (!allowed || !file.endsWith(".ts")) {
        refuse(
          problems,
          `${where}: sourceOracleOverlay file ${JSON.stringify(file)} is outside the oracle allowlist`,
        );
      }
    }
  }
  if (typeof overlay.reason !== "string" || overlay.reason.replace(/\s/g, "").length < 40) {
    refuse(
      problems,
      `${where}: sourceOracleOverlay needs a reason (at least 40 characters) saying why the tagged oracle cannot seed this dataset`,
    );
  }
}

function validateRemedies(dataset, expected, where, problems) {
  const remedies = dataset?.remedies;
  if (remedies === undefined) return [];
  if (!Array.isArray(remedies)) {
    refuse(problems, `${where}: remedies must be an array`);
    return [];
  }
  remedies.forEach((step, index) => {
    if (step?.kind !== "remedy") {
      refuse(problems, `${where} remedies ${index}: kind must be remedy`);
      return;
    }
    validateRemedyStep(step, `${where} remedies ${index}`, problems);
  });
  if (expected.length === 0) {
    refuse(
      problems,
      `${where}: remedies without expectFindings prove nothing; declare what the check must report first`,
    );
  }
  const expectedRefuses = new Set(
    expected.filter((finding) => finding?.severity === "refuse").map((finding) => finding.code),
  );
  for (const step of remedies) {
    if (
      step?.kind === "remedy" &&
      typeof step?.code === "string" &&
      !expectedRefuses.has(step.code)
    ) {
      refuse(problems, `${where}: remedy ${step.code} matches no expected refuse finding`);
    }
  }
  for (const code of expectedRefuses) {
    if (!remedies.some((step) => step?.kind === "remedy" && step?.code === code)) {
      refuse(
        problems,
        `${where}: expected refuse ${code} has no remedy; the rehearsal cannot prove the operator path past it`,
      );
    }
  }
  return remedies;
}

/** Validate a parsed rehearsal config. Returns the list of refusals (empty = valid). */
export function validateConfig(config) {
  const problems = [];
  const sources = Array.isArray(config?.sources) ? config.sources : null;
  const datasets = Array.isArray(config?.datasets) ? config.datasets : null;
  const required = Array.isArray(config?.requiredDatasetClasses)
    ? config.requiredDatasetClasses
    : null;
  if (!sources || sources.length === 0)
    refuse(
      problems,
      "no source releases: an upgrade gate with nothing to upgrade from proves nothing",
    );
  if (!datasets || datasets.length === 0) refuse(problems, "no datasets");
  if (!required || required.length === 0) refuse(problems, "requiredDatasetClasses is empty");
  if (problems.length > 0) return problems;

  const tags = new Set();
  for (const source of sources) {
    if (!TAG.test(source?.tag ?? ""))
      refuse(problems, `source ${JSON.stringify(source?.tag)} is not a release tag`);
    else if (tags.has(source.tag)) refuse(problems, `source ${source.tag} is listed twice`);
    tags.add(source?.tag);
    const defects = source?.knownHarnessDefects ?? [];
    if (!Array.isArray(defects))
      refuse(problems, `source ${source?.tag}: knownHarnessDefects must be an array`);
    else {
      for (const defect of defects) {
        if (!ID.test(defect?.check ?? ""))
          refuse(problems, `source ${source?.tag}: known harness defect needs its check name`);
        if (typeof defect?.reason !== "string" || defect.reason.replace(/\s/g, "").length < 40) {
          refuse(
            problems,
            `source ${source?.tag}: known harness defect ${defect?.check} needs a reason (at least 40 characters) saying why the tagged check is wrong`,
          );
        }
      }
    }
  }

  const ids = new Set();
  for (const dataset of datasets) {
    const where = `dataset ${JSON.stringify(dataset?.id)}`;
    if (!ID.test(dataset?.id ?? "")) refuse(problems, `${where}: id must be kebab-case`);
    else if (ids.has(dataset.id)) refuse(problems, `${where}: id is listed twice`);
    ids.add(dataset?.id);
    if (!required.includes(dataset?.class)) {
      refuse(problems, `${where}: class ${JSON.stringify(dataset?.class)} is not a required class`);
    }
    if (!Array.isArray(dataset?.steps)) refuse(problems, `${where}: steps must be an array`);
    else {
      dataset.steps.forEach((step, index) => {
        if (step?.kind === "remedy") {
          refuse(
            problems,
            `${where} step ${index}: remedy steps belong in the remedies array, not in steps`,
          );
        }
        validateStep(step, `${where} step ${index}`, problems);
      });
    }
    const expected = validateExpectFindings(dataset, where, problems);
    validateRemedies(dataset, expected, where, problems);
    validateSourceOracleOverlay(dataset, where, problems);
    if (dataset?.assertions !== undefined && typeof dataset.assertions !== "boolean") {
      refuse(problems, `${where}: assertions must be true or absent`);
    } else if (dataset?.assertions === true) {
      const file = join(HERE, "assertions", `${dataset.id}.mjs`);
      if (!existsSync(file)) {
        refuse(
          problems,
          `${where}: declares assertions but ${file} is missing; a deleted assertions file must not silently skip the phase`,
        );
      }
    }
    if (dataset?.class !== "empty" && Array.isArray(dataset?.steps) && dataset.steps.length === 0) {
      refuse(problems, `${where}: only the empty class may have no steps`);
    }
  }
  return problems;
}

/**
 * Required dataset classes no dataset covers yet. Kept apart from
 * validateConfig so that per-commit tests can prove the config is well-formed
 * while a class is still being built. The release-time plan refuses on gaps.
 */
export function coverageGaps(config) {
  const classes = new Set((config?.datasets ?? []).map((dataset) => dataset?.class));
  return (config?.requiredDatasetClasses ?? [])
    .filter((klass) => !classes.has(klass))
    .map((klass) => `required dataset class ${JSON.stringify(klass)} has no dataset`);
}

function hasBaselineIdentity(manifest) {
  return (
    typeof manifest?.filename === "string" &&
    manifest.filename.length > 0 &&
    typeof manifest?.baselineSha256 === "string" &&
    manifest.baselineSha256.length > 0
  );
}

function candidateBaselineRefusal(candidateBaseline) {
  if (
    hasBaselineIdentity(candidateBaseline) &&
    TAG.test(candidateBaseline?.upgradeFromRelease ?? "")
  )
    return null;
  return `the candidate has no usable release baseline manifest (${BASELINE_MANIFEST} with filename, baselineSha256 and upgradeFromRelease), so no source can be shown to upgrade into it`;
}

/**
 * Why a source release cannot upgrade into the candidate, or null when it
 * can. Exactly two upgrade paths exist. The candidate baseline's
 * `upgradeFromRelease` holds the exact previous-release ledger, so it adopts
 * the baseline (verified backup, catalog equality, exact ledger) and then
 * bootstraps. A later release whose tree already records the candidate's
 * baseline identity (`filename` and `baselineSha256`) upgrades by ordinary
 * bootstrap. Any other release holds a ledger the candidate can neither adopt
 * nor continue, so its cell could only rehearse a refusal.
 */
export function sourceUpgradeRefusal(tag, candidateBaseline, sourceBaseline) {
  const unusable = candidateBaselineRefusal(candidateBaseline);
  if (unusable) return unusable;
  const { filename, baselineSha256, upgradeFromRelease } = candidateBaseline;
  if (tag === upgradeFromRelease) return null;
  if (sourceBaseline?.filename === filename && sourceBaseline?.baselineSha256 === baselineSha256)
    return null;
  const held = hasBaselineIdentity(sourceBaseline)
    ? `${sourceBaseline.filename} at ${sourceBaseline.baselineSha256.slice(0, 12)}`
    : "no release baseline";
  return (
    `source ${tag ?? "(untagged)"} cannot upgrade into this candidate: it is not ${upgradeFromRelease} ` +
    `(the release that adopts ${filename}), and its tree records ${held} rather than ${filename} at ${baselineSha256.slice(0, 12)}. ` +
    `Its installations upgrade to ${upgradeFromRelease} first; remove it from rehearsal.json sources`
  );
}

/** The candidate's baseline manifest, or null when the candidate has none. */
export function readCandidateBaseline(path = CANDIDATE_BASELINE_PATH) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

/** The baseline manifest a checked-out source tree carries, or null when it has none. */
export function readSourceTreeBaseline(sourceDir) {
  return readCandidateBaseline(join(sourceDir, BASELINE_MANIFEST));
}

/**
 * The baseline manifest recorded at a release tag, or null when that tree has
 * none. A tag this checkout cannot resolve refuses: an unknown source tree
 * must never read as "no baseline" or as eligible.
 */
export function readSourceBaselineAtTag(tag, cwd = join(HERE, "..", "..")) {
  const git = (args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const ref = `refs/tags/${tag}`;
  try {
    git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  } catch {
    throw new Error(
      `release tag ${tag} is not available in this checkout; fetch release tags (git fetch --tags) so its baseline identity can be read`,
    );
  }
  try {
    git(["cat-file", "-e", `${ref}:${BASELINE_MANIFEST}`]);
  } catch {
    return null;
  }
  return JSON.parse(git(["show", `${ref}:${BASELINE_MANIFEST}`]));
}

/**
 * Refusals for configured sources that cannot upgrade into the candidate
 * (sourceUpgradeRefusal), plus a missing `upgradeFromRelease`: that is the
 * path every existing installation takes across the release cut, so the gate
 * must rehearse it. The previous release is accepted by tag alone; every
 * other source's tree is read at its tag.
 */
export function sourceEligibilityProblems(
  config,
  { candidateBaseline = readCandidateBaseline(), sourceBaseline = readSourceBaselineAtTag } = {},
) {
  const sources = Array.isArray(config?.sources) ? config.sources : [];
  const unusable = candidateBaselineRefusal(candidateBaseline);
  if (unusable) return [unusable];
  const problems = [];
  const { filename, upgradeFromRelease } = candidateBaseline;
  if (!sources.some((source) => source?.tag === upgradeFromRelease)) {
    refuse(
      problems,
      `sources must include ${upgradeFromRelease}: existing installations adopt ${filename} from it, and the gate must rehearse that path`,
    );
  }
  for (const source of sources) {
    if (source?.tag === upgradeFromRelease) continue;
    let held;
    try {
      held = sourceBaseline(source.tag);
    } catch (error) {
      refuse(
        problems,
        `source ${source?.tag}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    const refusal = sourceUpgradeRefusal(source.tag, candidateBaseline, held);
    if (refusal) refuse(problems, refusal);
  }
  return problems;
}

/** One matrix cell per (source, dataset), in config order. */
export function planMatrix(config, eligibility = {}) {
  const problems = validateConfig(config);
  if (problems.length === 0) problems.push(...coverageGaps(config));
  if (problems.length === 0) problems.push(...sourceEligibilityProblems(config, eligibility));
  if (problems.length > 0) {
    const error = new Error(`upgrade rehearsal config refused:\n  - ${problems.join("\n  - ")}`);
    error.problems = problems;
    throw error;
  }
  return {
    include: config.sources.flatMap((source) =>
      config.datasets.map((dataset) => ({ source: source.tag, dataset: dataset.id })),
    ),
  };
}

function validateDefaultGate(config, problems) {
  const gate = config?.defaultGate;
  if (!gate || typeof gate !== "object") {
    refuse(problems, "defaultGate is missing: the release default must name its datasets");
    return;
  }
  if (!Array.isArray(gate.datasets) || gate.datasets.length === 0) {
    refuse(problems, "defaultGate.datasets is empty: the release default proves nothing");
    return;
  }
  const ids = new Set((config?.datasets ?? []).map((dataset) => dataset?.id));
  const seen = new Set();
  for (const id of gate.datasets) {
    if (!ids.has(id)) refuse(problems, `defaultGate names unknown dataset ${JSON.stringify(id)}`);
    if (seen.has(id)) refuse(problems, `defaultGate lists dataset ${JSON.stringify(id)} twice`);
    seen.add(id);
  }
  const classes = new Set(
    (config?.datasets ?? [])
      .filter((dataset) => seen.has(dataset?.id))
      .map((dataset) => dataset?.class),
  );
  if (!classes.has("multi-entity")) {
    refuse(
      problems,
      "defaultGate must include a populated multi-entity-class dataset; an empty-only default proves no upgrade",
    );
  }
}

/** The release default: oldest plus latest source on the gate datasets. */
export function defaultMatrix(config, eligibility = {}) {
  const problems = validateConfig(config);
  if (problems.length === 0) {
    problems.push(...coverageGaps(config));
    validateDefaultGate(config, problems);
  }
  if (problems.length === 0) problems.push(...sourceEligibilityProblems(config, eligibility));
  if (problems.length > 0) {
    const error = new Error(`upgrade rehearsal config refused:\n  - ${problems.join("\n  - ")}`);
    error.problems = problems;
    throw error;
  }
  const tags = [...new Set([config.sources[0].tag, config.sources.at(-1).tag])];
  return {
    include: tags.flatMap((source) =>
      config.defaultGate.datasets.map((dataset) => ({ source, dataset })),
    ),
  };
}

export function loadConfig(path = CONFIG_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outputIndex = process.argv.indexOf("--github-output");
  try {
    const matrix = process.argv.includes("--default-only")
      ? defaultMatrix(loadConfig())
      : planMatrix(loadConfig());
    const json = JSON.stringify(matrix);
    if (outputIndex >= 0) {
      const target = process.argv[outputIndex + 1];
      if (!target) throw new Error("--github-output needs a path");
      appendFileSync(target, `matrix=${json}\n`);
    }
    console.log(JSON.stringify(matrix, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
