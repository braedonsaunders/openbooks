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
 *                      data is clean before the upgrade touches it
 *   snapshot-before    version-tolerant ledger fingerprint
 *   upgrade            candidate bootstrap over the populated install, timed
 *                      per migration
 *   ledger-complete    every candidate migration is recorded as applied
 *   idempotent         a second candidate bootstrap applies nothing
 *   ledger-parity      trial balance, documents, open balances, applications
 *                      and row counts are identical before and after
 *   candidate-harness  golden harness (candidate code) on every seeded org and
 *                      every org with posted activity
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
      else reject(new PhaseRefusal(phase, `${command} ${args.join(" ")} exited ${code ?? signal}`));
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

async function seedSim(step, sourceDir) {
  const env = { OPENBOOKS_SIM: "1" };
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
    env: { OPENBOOKS_SIM: "1" },
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
    env: { OPENBOOKS_SIM: "1" },
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

async function harness(phase, treeDir, orgIds) {
  for (const orgId of orgIds) {
    await run(phase, "npm", ["--prefix", "engine", "run", "--silent", "harness", "--", orgId], { cwd: treeDir });
  }
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

async function catalogSnapshot(phase, env) {
  return run(phase, "npx", ["tsx", "scripts/schema-catalog-snapshot.ts"], { cwd: CANDIDATE, env });
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
    await phase("source-harness", () => harness("source-harness", sourceDir, report.seededOrgs));

    const before = await phase("snapshot-before", () => withClient(dbUrl, snapshotLedger));
    writeFileSync(join(reportDir, "ledger-before.json"), `${JSON.stringify(before, null, 2)}\n`);
    const sourceLedger = await withClient(dbUrl, async (client) =>
      (await client.query("select filename from public._applied_migrations order by filename")).rows.map((row) => row.filename));

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
      withClient(dbUrl, (client) => snapshotLedger(client, { columns: fingerprintColumnsOf(before) })));
    writeFileSync(join(reportDir, "ledger-after.json"), `${JSON.stringify(after, null, 2)}\n`);
    await phase("ledger-parity", async () => {
      const differences = compareSnapshots(before, after);
      if (differences.length > 0) {
        report.refusals.push(...differences.slice(0, 200));
        throw new PhaseRefusal("ledger-parity", `${differences.length} ledger difference(s) across the upgrade`);
      }
    });

    await phase("candidate-harness", () =>
      harness("candidate-harness", CANDIDATE, candidateHarnessOrgIds(report.seededOrgs, after)));

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
  if (report.refusals.length > 0) {
    lines.push("", "Ledger differences (first 20):", "", "```json", JSON.stringify(report.refusals.slice(0, 20), null, 2), "```");
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
