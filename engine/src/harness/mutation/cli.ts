/**
 * `npm run test:mutation` entry point.
 *
 *   node --import tsx engine/src/harness/mutation/cli.ts \
 *     [--target <substring>] [--sample N] [--timeout-secs N] \
 *     [--report-dir <dir>] [--unit-only] [--list-targets] \
 *     [--write-checked-in] [--max-per-operator N]
 *
 * Unit-only mutants run without a database; DB-backed mapped files self-skip
 * and their mutants report `skipped`. With OPENBOOKS_DB_URL set (and without
 * --unit-only) the same run measures DB mutants too. The production database
 * is refused outright (see runner.assertNotProduction).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMutationConfig } from "./config.ts";
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
    const existing = readCheckedInReport(checkedIn);
    const merged = mergeCheckedInReports(
      existing,
      fresh,
      config.targets.map((t) => t.path),
    );
    writeFileSync(checkedIn, `${JSON.stringify(merged.report, null, 2)}\n`);
    console.log(`checked-in report updated: ${checkedIn}`);
    for (const line of merged.preserved) console.log(`preserve: ${line}`);
    for (const line of merged.dropped) console.log(`drop stale: ${line}`);
    if (merged.refusals.length > 0) {
      for (const line of merged.refusals) console.error(`REFUSAL: ${line}`);
      process.exitCode = 1;
    }
  }
  const blocked = report.targets.filter((t) => t.status === "baseline-failed");
  if (blocked.length > 0) {
    console.error(`baseline failed for: ${blocked.map((t) => t.target).join(", ")}`);
    process.exit(1);
  }
}

export interface CheckedInMerge {
  readonly report: CheckedInReport;
  /** Ratified entries kept because this run did not measure them (partial run or unmeasured target). */
  readonly preserved: readonly string[];
  /** Fresh measurements below a ratified score: kept ratified, caller must fail loudly. */
  readonly refusals: readonly string[];
  /** Entries dropped: full run, target no longer configured (e.g. decomposed monolith). */
  readonly dropped: readonly string[];
}

/** Tolerance matching the floor ratchet (`mutation-floor.test.ts`). */
const SCORE_EPSILON = 1e-9;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the checked-in report for merging. Missing file means first publish
 * (null). A corrupt file is a hard failure: overwriting it would manufacture
 * evidence, so the publish is refused instead.
 */
export function readCheckedInReport(path: string): CheckedInReport | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error(`checked-in report at ${path} is not valid JSON — refusing to overwrite it`);
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.targets)) {
    throw new Error(`checked-in report at ${path} is malformed — refusing to overwrite it`);
  }
  return parsed as CheckedInReport;
}

function isMeasured(entry: CheckedInTarget): boolean {
  return entry.measured > 0 && entry.ratio !== null;
}

function ratifyRemedy(target: string): string {
  return (
    `re-run \`npm run test:mutation -- --target ${target}\` to confirm, then either fix the ` +
    `surviving mutants or ratify explicitly by committing an updated mutation-report.json + ` +
    `mutation-floor.json together (coordinator decision)`;
}

/**
 * Merge a fresh run into the checked-in report without ever lowering ratified
 * evidence.
 *
 * - Targets absent from this (partial) run keep their ratified entries.
 * - Fresh entries that measured nothing (baseline-skipped, no-mutants,
 *   measured 0, null ratio) never overwrite a ratified measurement.
 * - A fresh measured score below a ratified score keeps the ratified entry
 *   and records a refusal naming the remedy; raises replace silently.
 * - A full run (every configured target present in the fresh report) drops
 *   entries for targets that are no longer configured — the only path by
 *   which stale monolith entries leave. A partial run preserves them.
 *
 * Floor raises stay an explicit ratification act: this merge never writes
 * `mutation-floor.json`.
 */
export function mergeCheckedInReports(
  existing: CheckedInReport | null,
  fresh: CheckedInReport,
  configuredPaths: readonly string[],
): CheckedInMerge {
  if (existing === null) {
    return { report: fresh, preserved: [], refusals: [], dropped: [] };
  }
  const configured = new Set(configuredPaths);
  const freshByTarget = new Map(fresh.targets.map((t) => [t.target, t]));
  const full = [...configured].every((p) => freshByTarget.has(p));
  const previous = new Map(existing.targets.map((t) => [t.target, t]));
  const merged: CheckedInTarget[] = [];
  const preserved: string[] = [];
  const refusals: string[] = [];
  const dropped: string[] = [];

  for (const entry of fresh.targets) {
    const prev = previous.get(entry.target);
    if (!prev) {
      merged.push(entry);
      continue;
    }
    if (!isMeasured(entry)) {
      if (isMeasured(prev)) {
        merged.push(prev);
        preserved.push(
          `${entry.target}: this run measured nothing (status ${entry.status}) — kept ratified score ${formatRatio(prev.ratio)}`,
        );
      } else {
        merged.push(entry);
      }
      continue;
    }
    if (prev.ratio !== null && entry.ratio < prev.ratio - SCORE_EPSILON) {
      merged.push(prev);
      refusals.push(
        `${entry.target}: fresh score ${formatRatio(entry.ratio)} below ratified ${formatRatio(prev.ratio)} — kept ratified entry; ${ratifyRemedy(entry.target)}`,
      );
      continue;
    }
    merged.push(entry);
  }
  for (const prev of existing.targets) {
    if (freshByTarget.has(prev.target)) continue;
    if (full && !configured.has(prev.target)) {
      dropped.push(prev.target);
      continue;
    }
    merged.push(prev);
    preserved.push(
      `${prev.target}: not in this run — kept ratified score ${formatRatio(prev.ratio)}`,
    );
  }

  const order = new Map(configuredPaths.map((p, i) => [p, i]));
  merged.sort((a, b) => (order.get(a.target) ?? configuredPaths.length) - (order.get(b.target) ?? configuredPaths.length));

  // A partial run must not present itself as a fresh full measurement: keep
  // the prior run's provenance. A full run adopts the fresh provenance.
  const report: CheckedInReport = full
    ? { ...fresh, targets: merged }
    : {
      version: 1,
      gitSha: existing.gitSha,
      ...(existing.runId !== undefined ? { runId: existing.runId } : {}),
      at: existing.at,
      mode: existing.mode,
      targets: merged,
    };
  return { report, preserved, refusals, dropped };
}

// Importing this module (e.g. from a unit test) must not launch a mutation
// run; only run when invoked as the CLI entry point.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
