#!/usr/bin/env node
/**
 * Rehearse one upgrade: a source release, a dataset, and this checkout as the candidate.
 *
 * RELEASE GATE ONLY (.github/workflows/upgrade-rehearsal.yml, dispatched for a
 * release candidate). It is never part of push or pull_request CI.
 *
 * The phases each fail closed and are named in the report:
 *
 *   reference-install  candidate bootstrap into an EMPTY reference database
 *   source-install     the source release's own bootstrap
 *   seed               the dataset, written by the SOURCE release's tooling
 *   source-harness     golden harness (source code) on every seeded org: the
 *                      data is clean before the upgrade touches it (only
 *                      checks the source DECLARES broken may fail)
 *   snapshot-before    version-tolerant ledger fingerprint
 *   preflight          candidate `bootstrap --check --json` over the populated
 *                      install (preflight.json); datasets with expectFindings
 *                      additionally prove refusal-without-change, remedies,
 *                      and a clean re-check before the upgrade runs
 *   upgrade            candidate bootstrap over the populated install, timed
 *                      per migration
 *   ledger-complete    every candidate migration is recorded as applied
 *   idempotent         a second candidate bootstrap applies nothing
 *   ledger-parity      trial balance, documents, open balances, applications
 *                      and row counts are identical before and after
 *   candidate-harness  golden harness (candidate code) on every seeded org and
 *                      every org with posted activity
 *   assertions         post-upgrade legacy assertions
 *                      (scripts/upgrade-rehearsal/assertions/<dataset>.mjs,
 *                      when that file exists; assertions.json)
 *   catalog            the upgraded schema equals a fresh install's
 *
 * Environment:
 *   OPENBOOKS_DB_URL / OPENBOOKS_RUNTIME_DB_URL   the install being upgraded
 *   OPENBOOKS_REFERENCE_DB_URL / OPENBOOKS_REFERENCE_RUNTIME_DB_URL
 *                                                 an empty database on a
 *                                                 SEPARATE cluster (roles are
 *                                                 cluster-wide)
 *
 *   node scripts/upgrade-rehearsal/rehearse.mjs --dataset small \
 *     --source-dir ../source --report-dir upgrade-report
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadConfig, validateConfig } from "./plan.mjs";
import { candidateHarnessOrgIds, compareSnapshots, fingerprintColumnsOf, snapshotLedger } from "./ledger.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CANDIDATE = resolve(HERE, "..", "..");
const APPLYING = /^\[bootstrap\] applying migration: (generated\/\S+\.sql)\s*$/;

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`--${name} is required`);
  return value;
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

class PhaseRefusal extends Error {
  constructor(phase, message, details) {
    super(`[${phase}] ${message}`);
    this.phase = phase;
    this.details = details;
  }
}

/**
 * Run a command, streaming its output, and resolve with the captured stdout.
 * `onLine` sees each stdout line with the wall-clock time it arrived.
 */
function run(phase, command, args, { cwd, env = {}, onLine } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    let pending = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
      pending += text;
      let newline;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        onLine?.(line, performance.now());
      }
    });
    child.on("error", (error) => reject(new PhaseRefusal(phase, `${command} failed to start: ${error.message}`)));
    child.on("close", (code, signal) => {
      if (pending) onLine?.(pending, performance.now());
      if (code === 0) resolvePromise(stdout);
      else {
        reject(new PhaseRefusal(phase, `${command} ${args.join(" ")} exited ${code ?? signal}`, { stdout }));
      }
    });
  });
}

async function withClient(connectionString, fn) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function lastJsonLine(phase, stdout) {
  const lines = stdout.trim().split("\n").filter((line) => line.trim().startsWith("{"));
  if (lines.length === 0) throw new PhaseRefusal(phase, "printed no JSON result");
  return JSON.parse(lines.at(-1));
}

/** Sorted multiset of "severity:code" over --check findings. */
export function findingKeys(findings) {
  return (findings ?? []).map((finding) => `${finding.severity}:${finding.code}`).sort();
}

/** Multiset difference between the reported and the expected finding keys. */
export function diffFindingKeys(actual, expected) {
  const remaining = [...actual];
  const missing = [];
  for (const key of expected) {
    const at = remaining.indexOf(key);
    if (at >= 0) remaining.splice(at, 1);
    else missing.push(key);
  }
  return { missing, extra: remaining };
}

/**
 * The source release's own tooling writes the dataset as the RUNTIME role,
 * the non-owner login an install's app and worker actually run as. Seeding
 * is tenant writes, and the migration login is a superuser in CI, which
 * FORCE ROW LEVEL SECURITY cannot bind. The source sim runs its harness as a
 * month-end invariant, and under that login the tagged rls-org-isolation
 * probe halts any multi-org seed (R1.13). Installs, upgrades, remedies, and
 * the source-harness PHASE keep the migration login. The tagged harness CLI
 * never sets an org context, so as the runtime role it can't read its own
 * org row and crashes before any check (R1.14). Its multi-org rls probe
 * failure there is a declared source defect instead.
 */
function sourceRuntimeEnv() {
  return { OPENBOOKS_SIM: "1", OPENBOOKS_DB_URL: requireEnv("OPENBOOKS_RUNTIME_DB_URL") };
}

async function seedSim(step, sourceDir) {
  const env = sourceRuntimeEnv();
  const provisioned = await run("seed", "npm", [
    "--prefix", "engine", "run", "--silent", "sim", "--",
    "provision", "--profile", step.profile, "--seed", step.seed, "--start", step.start, "--end", step.end,
  ], { cwd: sourceDir, env });
  const runDir = JSON.parse(provisioned).runDir;
  if (typeof runDir !== "string" || runDir.length === 0) throw new PhaseRefusal("seed", "sim provision returned no runDir");
  await run("seed", "npm", ["--prefix", "engine", "run", "--silent", "sim", "--", step.mode, runDir], {
    cwd: sourceDir,
    env,
  });
  const manifestPath = isAbsolute(runDir) ? join(runDir, "manifest.json") : join(sourceDir, "engine", runDir, "manifest.json");
  const orgId = JSON.parse(readFileSync(manifestPath, "utf8")).orgId;
  if (!orgId) throw new PhaseRefusal("seed", `sim manifest ${manifestPath} has no orgId`);
  return [orgId];
}

async function seedSamples(sourceDir) {
  const stdout = await run("seed", "npm", ["--prefix", "engine", "run", "--silent", "samples", "--", "prepare"], {
    cwd: sourceDir,
    env: sourceRuntimeEnv(),
  });
  const orgIds = stdout
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line).templateOrgId)
    .filter(Boolean);
  if (orgIds.length === 0) throw new PhaseRefusal("seed", "the source release prepared no sample-company templates");
  return orgIds;
}

/**
 * A seeder is candidate-owned code that drives the SOURCE release's own engine
 * (it is copied into the source tree and runs on the source's runtime). It
 * must print `{"orgIds": [...]}` as its last JSON line.
 */
async function seedWithSeeder(step, sourceDir) {
  const file = join(HERE, "seeders", `${step.name}.ts`);
  if (!existsSync(file)) throw new PhaseRefusal("seed", `seeder ${step.name} does not exist at ${file}`);
  const targetDir = join(sourceDir, "engine", "src", "upgrade-rehearsal-seed");
  mkdirSync(targetDir, { recursive: true });
  copyFileSync(file, join(targetDir, `${step.name}.ts`));
  const stdout = await run("seed", "npx", ["tsx", join("engine", "src", "upgrade-rehearsal-seed", `${step.name}.ts`), ...(step.args ?? [])], {
    cwd: sourceDir,
    env: sourceRuntimeEnv(),
  });
  const orgIds = lastJsonLine("seed", stdout).orgIds;
  if (!Array.isArray(orgIds) || orgIds.length === 0) throw new PhaseRefusal("seed", `seeder ${step.name} reported no orgIds`);
  return orgIds;
}

async function seed(dataset, sourceDir) {
  const orgIds = [];
  for (const step of dataset.steps) {
    if (step.kind === "sim") orgIds.push(...(await seedSim(step, sourceDir)));
    else if (step.kind === "samples") orgIds.push(...(await seedSamples(sourceDir)));
    else if (step.kind === "seeder") orgIds.push(...(await seedWithSeeder(step, sourceDir)));
    else throw new PhaseRefusal("seed", `unknown step kind ${step.kind}`);
  }
  return orgIds;
}

/** The golden harness's FAIL lines, split by whether the source declared them. */
export function classifyHarnessFailures(stdout, tolerated) {
  const failed = [...String(stdout).matchAll(/^\s*FAIL\s+(\S+)/gm)].map((match) => match[1]);
  return { failed, unexpected: failed.filter((name) => !tolerated.has(name)) };
}

/**
 * Run the golden harness on each org. `tolerated` names checks that are
 * DECLARED broken in a frozen source release (rehearsal.json
 * sources[].knownHarnessDefects). A run passes if every FAIL line it prints
 * is one of those checks. A non-zero exit with no FAIL line, or any
 * undeclared FAIL, is refused. The candidate harness is always run with no
 * tolerance, and it re-checks the same data after the upgrade.
 */
async function harness(phase, treeDir, orgIds, tolerated = new Set(), env = {}) {
  const toleratedRuns = [];
  for (const orgId of orgIds) {
    try {
      await run(phase, "npm", ["--prefix", "engine", "run", "--silent", "harness", "--", orgId], { cwd: treeDir, env });
    } catch (error) {
      if (tolerated.size === 0 || !(error instanceof PhaseRefusal) || typeof error.details?.stdout !== "string") throw error;
      const { failed, unexpected } = classifyHarnessFailures(error.details.stdout, tolerated);
      if (failed.length === 0 || unexpected.length > 0) {
        throw new PhaseRefusal(phase, `harness failed on org ${orgId}: ${unexpected.join(", ") || "non-zero exit with no FAIL line"}`);
      }
      toleratedRuns.push({ orgId, tolerated: failed });
    }
  }
  return toleratedRuns;
}

async function timedBootstrap(phase, env = {}) {
  const migrations = [];
  let open = null;
  const started = performance.now();
  const close = (at) => {
    if (open) migrations.push({ filename: open.filename, seconds: Number(((at - open.at) / 1000).toFixed(3)) });
    open = null;
  };
  await run(phase, "npx", ["tsx", "scripts/bootstrap.ts"], {
    cwd: CANDIDATE,
    env,
    onLine(line, at) {
      const match = APPLYING.exec(line.trim());
      if (match) {
        close(at);
        open = { filename: match[1], at };
      } else if (open && line.startsWith("[bootstrap]")) {
        // Any later bootstrap phase line ends the migration that was running.
        close(at);
      }
    },
  });
  close(performance.now());
  return { migrations, seconds: Number(((performance.now() - started) / 1000).toFixed(3)) };
}

function candidateMigrationFilenames() {
  return readdirSync(join(CANDIDATE, "schema", "migrations", "generated"))
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => `generated/${file}`);
}

function refuseFindings(result) {
  return (result.findings ?? []).filter((finding) => finding.severity === "refuse");
}

function noticeFindings(result) {
  return (result.findings ?? []).filter((finding) => finding.severity === "notice");
}

function refuseCodes(findings) {
  return [...new Set(findings.map((finding) => finding.code))].sort();
}

async function appliedFilenames(dbUrl) {
  return withClient(dbUrl, async (client) =>
    (await client.query("select filename from public._applied_migrations order by filename")).rows.map((row) => row.filename));
}

/**
 * The preflight phase runs before upgrade: the candidate's read-only
 * `bootstrap --check --json` over the populated install, written to
 * preflight.json. A dataset with no expectFindings must report no refuse
 * finding (an unexpected refuse fails the cell by name; unexpected notices
 * are listed in the summary). A dataset WITH expectFindings proves the
 * operator path end to end:
 *
 *   1. --check reports exactly those codes (no more, no fewer);
 *   2. plain bootstrap refuses and leaves _applied_migrations and the
 *      ledger fingerprint untouched;
 *   3. once the dataset's remedies (repo remedy files under
 *      schema/migrations/preflight/remedies/, the same files operators
 *      get) apply, --check reports no refuse finding;
 *   4. then the normal phases run.
 */
async function runPreflightPhase(dataset, reportDir, { dbUrl, before, sourceLedger }) {
  // `--check` exits 1 whenever it reports a refuse finding, which is exactly
  // what an edge-refusals dataset expects. Exit status alone therefore can't
  // mean "failed": the JSON result can. An `error` field (the check could not
  // run) refuses by name, and the report is written either way.
  const checkJson = async (reportName) => {
    let stdout;
    try {
      stdout = await run("preflight", "npx", ["tsx", "scripts/bootstrap.ts", "--check", "--json"], {
        cwd: CANDIDATE,
      });
    } catch (error) {
      if (!(error instanceof PhaseRefusal) || typeof error.details?.stdout !== "string") throw error;
      stdout = error.details.stdout;
    }
    const result = lastJsonLine("preflight", stdout);
    writeFileSync(join(reportDir, reportName), `${JSON.stringify(result, null, 2)}\n`);
    if (typeof result.error === "string") throw new PhaseRefusal("preflight", `upgrade check could not run: ${result.error}`);
    return result;
  };
  const first = await checkJson("preflight.json");
  const summary = { expected: false, refuses: [], notices: [] };
  const expected = dataset.expectFindings ?? null;
  if (!expected) {
    const refuses = refuseFindings(first);
    if (refuses.length > 0) {
      throw new PhaseRefusal(
        "preflight",
        `unexpected refuse finding(s): ${refuseCodes(refuses).join(", ")}; declare them in expectFindings with remedies or fix the data`,
      );
    }
    summary.notices = noticeFindings(first);
    return summary;
  }
  const { missing, extra } = diffFindingKeys(findingKeys(first.findings), findingKeys(expected));
  if (missing.length > 0 || extra.length > 0) {
    throw new PhaseRefusal(
      "preflight",
      `--check reported [${findingKeys(first.findings).join(", ")}] but the dataset expects [${findingKeys(expected).join(", ")}]`,
    );
  }
  summary.expected = true;
  summary.refuses = refuseFindings(first);

  let refused = false;
  try {
    await run("preflight", "npx", ["tsx", "scripts/bootstrap.ts"], { cwd: CANDIDATE });
  } catch (error) {
    if (!(error instanceof PhaseRefusal)) throw error;
    const stdout = error.details?.stdout ?? "";
    if (!/migration preflight/i.test(stdout)) {
      throw new PhaseRefusal("preflight", `bootstrap failed, but not on a migration preflight: ${error.message}`);
    }
    refused = true;
  }
  if (!refused) {
    throw new PhaseRefusal("preflight", "expected bootstrap to refuse on the preflight findings, but it applied cleanly");
  }

  const appliedAfter = await appliedFilenames(dbUrl);
  const ledgerDrift = appliedAfter.filter((file) => !sourceLedger.includes(file));
  if (ledgerDrift.length > 0 || appliedAfter.length !== sourceLedger.length) {
    throw new PhaseRefusal(
      "preflight",
      `the refused bootstrap changed _applied_migrations: ${ledgerDrift.join(", ") || "rows removed"}`,
    );
  }
  const after = await withClient(dbUrl, (client) => snapshotLedger(client, { columns: fingerprintColumnsOf(before) }));
  const differences = compareSnapshots(before, after);
  if (differences.length > 0) {
    throw new PhaseRefusal("preflight", `the refused bootstrap moved the ledger fingerprint: ${differences.length} difference(s)`);
  }

  for (const remedy of dataset.remedies ?? []) {
    const sqlPath = join(CANDIDATE, remedy.sql);
    if (!existsSync(sqlPath)) throw new PhaseRefusal("preflight", `remedy file ${remedy.sql} does not exist`);
    const sqlText = readFileSync(sqlPath, "utf8");
    await withClient(dbUrl, async (client) => {
      await client.query(sqlText);
    });
  }
  const second = await checkJson("preflight-after-remedies.json");
  const stillRefusing = refuseFindings(second);
  if (stillRefusing.length > 0) {
    throw new PhaseRefusal("preflight", `remedies did not clear the check: ${refuseCodes(stillRefusing).join(", ")}`);
  }
  summary.notices = [...noticeFindings(first), ...noticeFindings(second)];
  return summary;
}

async function catalogSnapshot(phase, env) {
  return run(phase, "npx", ["tsx", "scripts/schema-catalog-snapshot.ts"], { cwd: CANDIDATE, env });
}

/** The post-upgrade assertions script for a dataset, when one exists. */
export function assertionsFileFor(datasetId) {
  return join(HERE, "assertions", `${datasetId}.mjs`);
}

/**
 * The refusal message for an assertions result, or null when it passes.
 * Fail closed: a result that is not a non-empty assertions array refuses —
 * an assertions file that checks nothing must not read as green.
 */
export function assertionsRefusal(datasetId, result) {
  const checks = result?.assertions;
  if (!Array.isArray(checks) || checks.length === 0) {
    return `dataset ${datasetId} assertions declared no checks (assertions.json holds no non-empty assertions array)`;
  }
  const failed = checks.filter((check) => !check || check.ok !== true);
  if (failed.length === 0) return null;
  const names = failed.map((check) => check?.name ?? "(unnamed check)").join(", ");
  return `dataset ${datasetId} failed ${failed.length} post-upgrade assertion(s): ${names}`;
}

/**
 * The assertions phase runs after the candidate harness: legacy handling
 * that is only observable on the upgraded install (frozen-or-refused
 * artifacts, paused schedules, provenance rows) is checked by the
 * dataset's own script on the candidate runtime, with the upgraded
 * install in OPENBOOKS_DB_URL and the seeded orgs in
 * UPGRADE_SEEDED_ORGS (JSON array). The script must print a final JSON
 * line shaped {"assertions": [{"name", "ok", "detail"?}]} and exit 0;
 * any failed check, or a result that declares no checks, refuses the
 * rehearsal by name. A dataset with no assertions file skips the phase.
 */
async function runAssertionsPhase(datasetId, reportDir, { seededOrgs }) {
  const file = assertionsFileFor(datasetId);
  if (!existsSync(file)) return { ran: false, file: null, passed: [], failed: [] };
  const stdout = await run("assertions", "npx", ["tsx", file], {
    cwd: CANDIDATE,
    env: { UPGRADE_SEEDED_ORGS: JSON.stringify(seededOrgs) },
  });
  const result = lastJsonLine("assertions", stdout);
  writeFileSync(join(reportDir, "assertions.json"), `${JSON.stringify(result, null, 2)}\n`);
  const refusal = assertionsRefusal(datasetId, result);
  if (refusal) {
    const failed = (result.assertions ?? []).filter((check) => !check || check.ok !== true);
    throw new PhaseRefusal("assertions", refusal, { failed });
  }
  return { ran: true, file, passed: result.assertions.map((check) => check.name), failed: [] };
}

async function main() {
  const datasetId = arg("dataset");
  const sourceDir = resolve(arg("source-dir"));
  const reportDir = resolve(arg("report-dir"));
  mkdirSync(reportDir, { recursive: true });

  const config = loadConfig();
  const problems = validateConfig(config);
  if (problems.length > 0) throw new PhaseRefusal("config", problems.join("; "));
  const dataset = config.datasets.find((candidate) => candidate.id === datasetId);
  if (!dataset) throw new PhaseRefusal("config", `unknown dataset ${datasetId}`);

  const dbUrl = requireEnv("OPENBOOKS_DB_URL");
  requireEnv("OPENBOOKS_RUNTIME_DB_URL");
  const referenceEnv = {
    OPENBOOKS_DB_URL: requireEnv("OPENBOOKS_REFERENCE_DB_URL"),
    OPENBOOKS_RUNTIME_DB_URL: requireEnv("OPENBOOKS_REFERENCE_RUNTIME_DB_URL"),
  };

  const report = {
    dataset: datasetId,
    source: process.env.UPGRADE_SOURCE_TAG ?? sourceDir,
    candidate: process.env.UPGRADE_CANDIDATE_SHA ?? null,
    phases: [],
    seededOrgs: [],
    upgrade: null,
    preflight: null,
    assertions: null,
    refusals: [],
    ok: false,
  };
  const writeReport = () => writeFileSync(join(reportDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

  const phase = async (name, fn) => {
    const started = performance.now();
    console.log(`\n=== upgrade rehearsal: ${name} ===`);
    try {
      const result = await fn();
      report.phases.push({ name, ok: true, seconds: Number(((performance.now() - started) / 1000).toFixed(3)) });
      return result;
    } catch (error) {
      report.phases.push({ name, ok: false, seconds: Number(((performance.now() - started) / 1000).toFixed(3)) });
      throw error instanceof PhaseRefusal ? error : new PhaseRefusal(name, error instanceof Error ? error.message : String(error));
    } finally {
      writeReport();
    }
  };

  try {
    await phase("reference-install", () => run("reference-install", "npx", ["tsx", "scripts/bootstrap.ts"], { cwd: CANDIDATE, env: referenceEnv }));
    const reference = await phase("reference-catalog", () => catalogSnapshot("reference-catalog", referenceEnv));
    writeFileSync(join(reportDir, "catalog-reference.json"), reference);

    await phase("source-install", () => run("source-install", "npx", ["tsx", "scripts/bootstrap.ts"], { cwd: sourceDir }));
    report.seededOrgs = await phase("seed", () => seed(dataset, sourceDir));
    const sourceEntry = config.sources.find((candidate) => candidate.tag === process.env.UPGRADE_SOURCE_TAG);
    const toleratedAtSource = new Set((sourceEntry?.knownHarnessDefects ?? []).map((defect) => defect.check));
    report.toleratedSourceHarness = await phase("source-harness", () =>
      harness("source-harness", sourceDir, report.seededOrgs, toleratedAtSource));

    const before = await phase("snapshot-before", () => withClient(dbUrl, snapshotLedger));
    writeFileSync(join(reportDir, "ledger-before.json"), `${JSON.stringify(before, null, 2)}\n`);
    const sourceLedger = await withClient(dbUrl, async (client) =>
      (await client.query("select filename from public._applied_migrations order by filename")).rows.map((row) => row.filename));

    report.preflight = await phase("preflight", () =>
      runPreflightPhase(dataset, reportDir, { dbUrl, before, sourceLedger }));

    // Remedies change data on purpose, and an operator runs them BEFORE
    // upgrading. From here the parity baseline is the remedied install, and
    // the source harness proves the remedies left it clean, so the upgrade is
    // judged only on what the upgrade itself did.
    let baseline = before;
    if ((dataset.remedies ?? []).length > 0) {
      baseline = await phase("snapshot-after-remedies", () =>
        withClient(dbUrl, (client) => snapshotLedger(client, { columns: fingerprintColumnsOf(before) })));
      writeFileSync(join(reportDir, "ledger-after-remedies.json"), `${JSON.stringify(baseline, null, 2)}\n`);
      await phase("source-harness-after-remedies", () =>
        harness("source-harness-after-remedies", sourceDir, report.seededOrgs, toleratedAtSource));
    }

    report.upgrade = await phase("upgrade", () => timedBootstrap("upgrade"));
    report.upgrade.pending = candidateMigrationFilenames().filter((file) => !sourceLedger.includes(file));
    report.upgrade.migrations.sort((left, right) => right.seconds - left.seconds);

    await phase("ledger-complete", async () => {
      const applied = await withClient(dbUrl, async (client) =>
        new Set((await client.query("select filename from public._applied_migrations")).rows.map((row) => row.filename)));
      const missing = candidateMigrationFilenames().filter((file) => !applied.has(file));
      if (missing.length > 0) throw new PhaseRefusal("ledger-complete", `not recorded as applied: ${missing.join(", ")}`);
    });

    await phase("idempotent", async () => {
      const again = await timedBootstrap("idempotent");
      if (again.migrations.length > 0) {
        throw new PhaseRefusal("idempotent", `a second bootstrap applied ${again.migrations.map((m) => m.filename).join(", ")}`);
      }
    });

    const after = await phase("snapshot-after", () =>
      withClient(dbUrl, (client) => snapshotLedger(client, { columns: fingerprintColumnsOf(baseline) })));
    writeFileSync(join(reportDir, "ledger-after.json"), `${JSON.stringify(after, null, 2)}\n`);
    await phase("ledger-parity", async () => {
      const differences = compareSnapshots(baseline, after);
      if (differences.length > 0) {
        report.refusals.push(...differences.slice(0, 200));
        throw new PhaseRefusal("ledger-parity", `${differences.length} ledger difference(s) across the upgrade`);
      }
    });

    await phase("candidate-harness", () =>
      harness("candidate-harness", CANDIDATE, candidateHarnessOrgIds(report.seededOrgs, after)));

    report.assertions = await phase("assertions", () =>
      runAssertionsPhase(datasetId, reportDir, { seededOrgs: report.seededOrgs }));

    await phase("catalog", async () => {
      const actual = await catalogSnapshot("catalog", {});
      writeFileSync(join(reportDir, "catalog-upgraded.json"), actual);
      const comparison = JSON.parse(await run("catalog", "node", [
        "scripts/compare-schema-catalogs.mjs",
        join(reportDir, "catalog-upgraded.json"),
        join(reportDir, "catalog-reference.json"),
      ], { cwd: CANDIDATE }));
      writeFileSync(join(reportDir, "catalog-comparison.json"), `${JSON.stringify(comparison, null, 2)}\n`);
      if (comparison.equivalent !== true) {
        throw new PhaseRefusal("catalog", "the upgraded schema differs from a fresh install (see catalog-comparison.json)");
      }
    });

    report.ok = true;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    console.error(`\nUPGRADE REHEARSAL REFUSED: ${report.error}`);
  } finally {
    writeReport();
    writeFileSync(join(reportDir, "summary.md"), summarize(report));
  }
  return report.ok ? 0 : 1;
}

export function summarize(report) {
  const lines = [
    `### Upgrade rehearsal: ${report.source} → ${report.candidate ?? "candidate"} · dataset \`${report.dataset}\``,
    "",
    report.ok ? "**PASS**" : `**REFUSED:** ${report.error ?? "unknown"}`,
    "",
    "| phase | result | seconds |",
    "|---|---|---|",
    ...report.phases.map((p) => `| ${p.name} | ${p.ok ? "ok" : "REFUSED"} | ${p.seconds} |`),
  ];
  if (report.upgrade) {
    lines.push(
      "",
      `Upgrade applied ${report.upgrade.migrations.length} migration(s) in ${report.upgrade.seconds}s. Slowest:`,
      "",
      "| migration | seconds |",
      "|---|---|",
      ...report.upgrade.migrations.slice(0, 10).map((m) => `| ${m.filename} | ${m.seconds} |`),
    );
  }
  if ((report.toleratedSourceHarness ?? []).length > 0) {
    lines.push(
      "",
      "Source-harness failures tolerated as declared known defects of the source release (the candidate harness re-checks with no tolerance):",
      "",
      ...report.toleratedSourceHarness.map((entry) => `- org ${entry.orgId}: ${entry.tolerated.join(", ")}`),
    );
  }
  if (report.refusals.length > 0) {
    lines.push("", "Ledger differences (first 20):", "", "```json", JSON.stringify(report.refusals.slice(0, 20), null, 2), "```");
  }
  if (report.preflight?.notices?.length > 0) {
    const codes = [...new Set(report.preflight.notices.map((notice) => notice.code))].sort();
    lines.push("", `Preflight notices (upgrade continued): ${codes.join(", ")}`);
  }
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
