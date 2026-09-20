/**
 * `npm run test:mutation` entry point.
 *
 *   node --import tsx engine/src/harness/mutation/cli.ts \
 *     [--target <substring>] [--sample N] [--timeout-secs N] \
 *     [--report-dir <dir>] [--unit-only] [--list-targets] \
 *     [--write-checked-in] [--max-per-operator N]
 *
 * Unit-only mutants run without a database; targets with an audited database
 * requirement report unmeasured with their reason. With OPENBOOKS_DB_URL set (and without
 * --unit-only) the same run measures DB mutants too. The production database
 * is refused outright (see runner.assertNotProduction).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMutationConfig, type MutationTargetConfig } from "./config.ts";
import { runMutationTargets, type MutationReport, type TargetResult } from "./runner.ts";

const REPO_ROOT = new URL("../../../..", import.meta.url).pathname.replace(/\/$/, "");

interface CliArgs {
  targets: string[];
  sample: number;
  timeoutSecs: number;
  reportDir: string;
  unitOnly: boolean;
  listTargets: boolean;
  writeCheckedIn: boolean;
  maxPerOperator: number | undefined;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    targets: [], sample: 25, timeoutSecs: 240,
    reportDir: "", unitOnly: false, listTargets: false,
    writeCheckedIn: false, maxPerOperator: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`flag ${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === "--target") args.targets.push(next());
    else if (arg === "--sample") args.sample = Number(next());
    else if (arg === "--timeout-secs") args.timeoutSecs = Number(next());
    else if (arg === "--report-dir") args.reportDir = next();
    else if (arg === "--unit-only") args.unitOnly = true;
    else if (arg === "--list-targets") args.listTargets = true;
    else if (arg === "--write-checked-in") args.writeCheckedIn = true;
    else if (arg === "--max-per-operator") args.maxPerOperator = Number(next());
    else throw new Error(`unknown flag: ${arg}`);
  }
  if (!Number.isSafeInteger(args.sample) || args.sample < 0) throw new Error("--sample must be a non-negative integer");
  if (!Number.isSafeInteger(args.timeoutSecs) || args.timeoutSecs <= 0) {
    throw new Error("--timeout-secs must be a positive integer");
  }
  if (!args.reportDir) args.reportDir = join(REPO_ROOT, ".local", "mutation");
  return args;
}

function formatRatio(ratio: number | null): string {
  return ratio === null ? "n/a" : `${(ratio * 100).toFixed(1)}%`;
}

function renderMarkdown(report: MutationReport): string {
  const lines: string[] = [];
  lines.push("# Mutation report");
  lines.push("");
  lines.push(`- at: ${report.at}`);
  lines.push(`- git: ${report.gitSha ?? "unknown"}${report.dirtyTargets.length > 0 ? ` (dirty: ${report.dirtyTargets.join(", ")})` : ""}`);
  lines.push(`- mode: ${report.mode} (sample ${report.sample}/target, timeout ${report.timeoutSecs}s)`);
  lines.push("");
  lines.push("| target | status | score | killed | survived | timed-out | skipped | error |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const t of report.targets) {
    lines.push(
      `| ${t.target} | ${t.status} | ${formatRatio(t.ratio)} | ${t.killed} | ${t.survived} | ${t.timedOut} | ${t.skipped} | ${t.error} |`,
    );
  }
  lines.push("");
  for (const t of report.targets) {
    lines.push(`## ${t.target} (${t.status}, score ${formatRatio(t.ratio)})`);
    lines.push("");
    if (t.unmeasuredReason) lines.push(`Unmeasured: ${t.unmeasuredReason}`, "");
    const survivors = t.mutants.filter((m) => m.status === "survived").slice(0, 8);
    if (survivors.length > 0) {
      lines.push("Top surviving mutants (the suite cannot see these behavior changes):");
      lines.push("");
      for (const m of survivors) {
        lines.push(`- \`${m.key}\` — ${m.description} — ${m.detail}`);
      }
      lines.push("");
    } else {
      lines.push("No surviving mutants in the sampled set.");
      lines.push("");
    }
    const errors = t.mutants.filter((m) => m.status === "error");
    if (errors.length > 0) {
      lines.push(`Unparseable mutants excluded from the score (${errors.length}):`);
      lines.push("");
      for (const m of errors.slice(0, 5)) {
        lines.push(`- \`${m.key}\` — ${m.detail}`);
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

export interface CheckedInTarget {
  readonly target: string;
  readonly needsDb: boolean;
  readonly unmeasuredReason?: string;
  readonly status: TargetResult["status"];
  readonly killed: number;
  readonly survived: number;
  readonly timedOut: number;
  readonly skipped: number;
  readonly error: number;
  readonly total: number;
  readonly measured: number;
  readonly ratio: number | null;
  readonly topSurvivors: ReadonlyArray<{
    readonly key: string;
    readonly line: number;
    readonly operator: string;
    readonly description: string;
  }>;
}

export interface CheckedInReport {
  readonly version: 1;
  readonly gitSha: string | null;
  // Optional: ratified files predate provenance embedding; new runs carry it.
  readonly runId?: string | null;
  readonly at: string;
  readonly mode: "unit" | "db";
  readonly targets: readonly CheckedInTarget[];
}

/** Compact ratified measurement consumed by the floor test and trust docs. */
export function toCheckedInReport(report: MutationReport): CheckedInReport {
  return {
    version: 1,
    gitSha: report.gitSha,
    runId: report.runId,
    at: report.at,
    mode: report.mode,
    targets: report.targets.map((t) => ({
      target: t.target,
      needsDb: t.needsDb,
      ...(t.unmeasuredReason ? { unmeasuredReason: t.unmeasuredReason } : {}),
      status: t.status,
      killed: t.killed,
      survived: t.survived,
      timedOut: t.timedOut,
      skipped: t.skipped,
      error: t.error,
      total: t.total,
      measured: t.measured,
      ratio: t.ratio,
      topSurvivors: t.mutants
        .filter((m) => m.status === "survived")
        .slice(0, 5)
        .map((m) => ({ key: m.key, line: m.line, operator: m.operator, description: m.description })),
    })),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadMutationConfig();
  if (args.listTargets) {
    for (const t of config.targets) {
      console.log(`${t.path} <- ${t.tests.join(", ")}${t.needsDb ? " [needsDb]" : ""}`);
    }
    return;
  }
  const selected = config.targets.filter(
    (t) => args.targets.length === 0 || args.targets.some((f) => t.path.includes(f)),
  );
  if (selected.length === 0) throw new Error("no targets selected");
  const useDb = !args.unitOnly && Boolean(process.env.OPENBOOKS_DB_URL);
  console.log(`mutation run: ${selected.length} target(s), sample=${args.sample}, timeout=${args.timeoutSecs}s, mode=${useDb ? "db" : "unit"}`);
  const report = await runMutationTargets({
    repoRoot: REPO_ROOT,
    targets: selected,
    sample: args.sample,
    timeoutSecs: args.timeoutSecs,
    useDb,
    ...(args.maxPerOperator !== undefined ? { maxPerOperator: args.maxPerOperator } : {}),
    onProgress: (message) => console.log(message),
  });
  const dir = resolve(args.reportDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "mutation-report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(dir, "mutation-report.md"), renderMarkdown(report));
  console.log(`\nreport written: ${join(dir, "mutation-report.json")}`);
  console.log(renderMarkdown(report).split("\n").slice(0, 8).join("\n"));
  if (args.writeCheckedIn) {
    const checkedIn = join(REPO_ROOT, "engine", "src", "harness", "mutation", "mutation-report.json");
    const fresh = toCheckedInReport(report);
    const floors = readRatifiedFloors(join(REPO_ROOT, "engine", "src", "harness", "mutation", "mutation-floor.json"));
    const refusals = checkedInPublishRefusals(fresh, config.targets, floors.floors);
    if (refusals.length > 0) {
      for (const line of refusals) console.error(`REFUSAL: ${line}`);
      console.error(`checked-in report NOT updated: ${checkedIn}`);
      process.exitCode = 1;
    } else {
      writeFileSync(checkedIn, `${JSON.stringify(fresh, null, 2)}\n`);
      console.log(`checked-in report updated: ${checkedIn}`);
    }
  }
  const blocked = report.targets.filter((t) => t.status === "baseline-failed");
  if (blocked.length > 0) {
    console.error(`baseline failed for: ${blocked.map((t) => t.target).join(", ")}`);
    process.exit(1);
  }
}

/** Tolerance matching the floor ratchet (`mutation-floor.test.ts`). */
const SCORE_EPSILON = 1e-9;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface RatifiedFloors {
  readonly version: 1;
  readonly floors: Record<string, { readonly ratio: number; readonly measured: number; readonly mode: string }>;
}

/**
 * Read the ratified floors the publish is checked against. A missing or
 * malformed floor file is a hard failure: without the ratchet there is
 * nothing to refuse against, so the publish is refused instead of guessed.
 */
export function readRatifiedFloors(path: string): RatifiedFloors {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`ratified floors at ${path} cannot be read — refusing publish: ${String(error)}`);
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.floors)) {
    throw new Error(`ratified floors at ${path} are malformed — refusing publish`);
  }
  const floors: RatifiedFloors["floors"] = {};
  for (const [key, value] of Object.entries(parsed.floors)) {
    if (!isRecord(value) || typeof value.ratio !== "number" || !Number.isFinite(value.ratio) || value.ratio < 0 || value.ratio > 1
      || typeof value.measured !== "number" || !Number.isSafeInteger(value.measured) || value.measured < 0
      || (value.mode !== "unit" && value.mode !== "db")) {
      throw new Error(`ratified floor for ${key} is malformed — refusing publish`);
    }
    floors[key] = { ratio: value.ratio, measured: value.measured, mode: value.mode };
  }
  return { version: 1, floors };
}

function measurementRemedy(target: string): string {
  return (
    `re-run \`npm run test:mutation -- --target ${target}\` to confirm, then add tests for the ` +
    `surviving behavior changes and re-run the full corpus; mutation-floor.json is raise-only`
  );
}

/**
 * Atomic publish gate for `--write-checked-in`: returns every reason the
 * fresh run must NOT become the checked-in report. Empty means publish.
 *
 * The run must cover exactly all configured targets — no partial selection,
 * no unconfigured extras. Every target must be honestly measured in this
 * run, except a declared `needsDb` target whose baseline self-skipped in a
 * unit-mode run (existing policy, also excused by the floor test). Refused:
 * baseline-failed, no-mutants, any other unmeasured entry, and any measured
 * score below its RATIFIED floor. Targets with no floor entry yet (freshly
 * extracted modules) publish on their real measurement; this gate never
 * invents floors — raises and first floors stay an explicit ratification act,
 * and this gate never writes `mutation-floor.json`.
 *
 * Nothing is carried forward and nothing is written when refusals exist: the
 * caller refuses before any checked-in write. The local report under
 * `--report-dir` is unaffected and always written.
 */
export function checkedInPublishRefusals(
  fresh: CheckedInReport,
  configured: readonly MutationTargetConfig[],
  floors: RatifiedFloors["floors"],
): string[] {
  const refusals: string[] = [];
  const configuredByPath = new Map(configured.map((t) => [t.path, t]));
  const freshByTarget = new Map(fresh.targets.map((t) => [t.target, t]));

  const missing = configured.map((t) => t.path).filter((p) => !freshByTarget.has(p));
  if (missing.length > 0) {
    refusals.push(
      `partial run: missing configured targets (${missing.join(", ")}) — re-run without --target so the publish measures everything`,
    );
  }
  for (const path of freshByTarget.keys()) {
    if (!configuredByPath.has(path)) {
      refusals.push(
        `unconfigured target in run: ${path} — the config changed mid-run; re-run against the current mutation.config.json`,
      );
    }
  }

  for (const entry of fresh.targets) {
    const target = configuredByPath.get(entry.target);
    if (entry.status === "baseline-failed") {
      refusals.push(`${entry.target}: baseline failed — the harness cannot measure it; fix the baseline and re-run`);
      continue;
    }
    if (entry.status === "no-mutants") {
      refusals.push(`${entry.target}: zero mutants generated — operators cover nothing; fix generation and re-run`);
      continue;
    }
    if (entry.measured <= 0 || entry.ratio === null) {
      const excused = target?.needsDb === true && fresh.mode === "unit";
      if (!excused) {
        refusals.push(
          `${entry.target}: nothing measured (status ${entry.status}) — re-run with a database or fix the baseline`,
        );
      }
      continue;
    }
    if (!Number.isFinite(entry.ratio) || entry.ratio < 0 || entry.ratio > 1) {
      refusals.push(`${entry.target}: invalid ratio — fix the measurement and re-run`);
      continue;
    }
    const floor = floors[entry.target];
    if (floor !== undefined && entry.ratio < floor.ratio - SCORE_EPSILON) {
      refusals.push(
        `${entry.target}: fresh score ${formatRatio(entry.ratio)} below ratified floor ${formatRatio(floor.ratio)} — publish refused; ${measurementRemedy(entry.target)}`,
      );
    }
  }
  return refusals;
}

// Importing this module (e.g. from a unit test) must not launch a mutation
// run; only run when invoked as the CLI entry point.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
