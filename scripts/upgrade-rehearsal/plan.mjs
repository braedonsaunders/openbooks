#!/usr/bin/env node
/**
 * Plan the release-only upgrade rehearsal matrix.
 *
 * Reads rehearsal.json and emits one matrix cell per (source release, dataset).
 * The config is validated first, and this fails closed. A required dataset
 * class with no dataset, an unknown step kind, or a malformed source tag is
 * refused by name. A matrix that silently lost a class would still go green
 * while rehearsing less than the gate promises.
 *
 *   node scripts/upgrade-rehearsal/plan.mjs                  # print the matrix
 *   node scripts/upgrade-rehearsal/plan.mjs --github-output "$GITHUB_OUTPUT"
 */
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const CONFIG_PATH = join(HERE, "rehearsal.json");

export const STEP_KINDS = Object.freeze(["sim", "samples", "seeder"]);
const SIM_MODES = new Set(["run", "endurance"]);
const TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
const ID = /^[a-z0-9][a-z0-9-]*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function refuse(problems, message) {
  problems.push(message);
}

function validateStep(step, where, problems) {
  if (!step || typeof step !== "object") return refuse(problems, `${where}: step is not an object`);
  if (!STEP_KINDS.includes(step.kind)) {
    return refuse(problems, `${where}: unknown step kind ${JSON.stringify(step.kind)} (known: ${STEP_KINDS.join(", ")})`);
  }
  if (step.kind === "sim") {
    if (!SIM_MODES.has(step.mode)) refuse(problems, `${where}: sim mode must be run or endurance`);
    for (const key of ["profile", "seed"]) {
      if (typeof step[key] !== "string" || step[key].length === 0) refuse(problems, `${where}: sim step needs ${key}`);
    }
    for (const key of ["start", "end"]) {
      if (!DATE.test(step[key] ?? "")) refuse(problems, `${where}: sim step ${key} must be YYYY-MM-DD`);
    }
    if (DATE.test(step.start ?? "") && DATE.test(step.end ?? "") && step.start > step.end) {
      refuse(problems, `${where}: sim step starts after it ends`);
    }
  }
  if (step.kind === "seeder" && !ID.test(step.name ?? "")) {
    refuse(problems, `${where}: seeder step needs a kebab-case name`);
  }
}

/** Validate a parsed rehearsal config. Returns the list of refusals (empty = valid). */
export function validateConfig(config) {
  const problems = [];
  const sources = Array.isArray(config?.sources) ? config.sources : null;
  const datasets = Array.isArray(config?.datasets) ? config.datasets : null;
  const required = Array.isArray(config?.requiredDatasetClasses) ? config.requiredDatasetClasses : null;
  if (!sources || sources.length === 0) refuse(problems, "no source releases: an upgrade gate with nothing to upgrade from proves nothing");
  if (!datasets || datasets.length === 0) refuse(problems, "no datasets");
  if (!required || required.length === 0) refuse(problems, "requiredDatasetClasses is empty");
  if (problems.length > 0) return problems;

  const tags = new Set();
  for (const source of sources) {
    if (!TAG.test(source?.tag ?? "")) refuse(problems, `source ${JSON.stringify(source?.tag)} is not a release tag`);
    else if (tags.has(source.tag)) refuse(problems, `source ${source.tag} is listed twice`);
    tags.add(source?.tag);
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
    else dataset.steps.forEach((step, index) => validateStep(step, `${where} step ${index}`, problems));
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

/** One matrix cell per (source, dataset), in config order. */
export function planMatrix(config) {
  const problems = validateConfig(config);
  if (problems.length === 0) problems.push(...coverageGaps(config));
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

export function loadConfig(path = CONFIG_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outputIndex = process.argv.indexOf("--github-output");
  try {
    const matrix = planMatrix(loadConfig());
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
