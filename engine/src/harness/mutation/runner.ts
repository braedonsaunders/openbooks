/**
 * Scratch-copy mutation runner.
 *
 * For each curated target: copy the worktree to a temp dir (tracked files
 * only, `node_modules` symlinked — the worktree source is never mutated),
 * run the mapped tests unmutated (baseline must be green, otherwise the
 * target cannot be measured), then run each sampled mutant the same way.
 *
 * Verdicts:
 * - killed:     at least one mapped test failed on the mutant.
 * - survived:   every executed test passed.
 * - timed-out:  the mutant run exceeded its budget (counts as killed in the
 *               score — a hang is a detected behavior change — but is
 *               reported separately so timeout flakes stay visible).
 * - skipped:    zero tests executed (typically DB-backed files in unit mode,
 *               where they self-skip without OPENBOOKS_DB_URL).
 * - error:      the mutant does not parse, or the run crashed without
 *               executing anything. Excluded from the score and NEVER counted
 *               as killed: a build break proves nothing about the suite.
 */
import { execFileSync, spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { MutationTargetConfig } from "./config.ts";
import { generateMutants, type GeneratedMutant } from "./operators.ts";
import { caseDigest, runId, sourceSha } from "../../platform/provenance.ts";

export type MutantStatus = "killed" | "survived" | "timed-out" | "skipped" | "error";

export interface MutantResult {
  readonly key: string;
  readonly target: string;
  readonly operator: string;
  readonly line: number;
  readonly description: string;
  readonly status: MutantStatus;
  readonly detail: string;
  readonly durationMs: number;
}

export interface BaselineFile {
  readonly file: string;
  readonly tests: number;
  readonly pass: number;
  readonly fail: number;
  readonly skipped: number;
  readonly executed: boolean;
}

export type TargetStatus = "measured" | "baseline-failed" | "baseline-skipped" | "no-mutants";

export interface TargetResult {
  readonly target: string;
  readonly status: TargetStatus;
  readonly needsDb: boolean;
  readonly killed: number;
  readonly survived: number;
  readonly timedOut: number;
  readonly skipped: number;
  readonly error: number;
  readonly total: number;
  readonly measured: number;
  /** (killed + timedOut) / measured, or null when nothing was measured. */
  readonly ratio: number | null;
  readonly baselineFiles: BaselineFile[];
  readonly mutants: MutantResult[];
}

export interface MutationReport {
  readonly version: 1;
  readonly gitSha: string | null;
  readonly runId: string | null;
  readonly casesSha256: string;
  readonly dirtyTargets: string[];
  readonly at: string;
  readonly mode: "unit" | "db";
  readonly sample: number;
  readonly timeoutSecs: number;
  readonly targets: TargetResult[];
}

export interface RunMutationOptions {
  readonly repoRoot: string;
  readonly targets: readonly MutationTargetConfig[];
  readonly sample: number;
  readonly timeoutSecs: number;
  readonly useDb: boolean;
  readonly maxPerOperator?: number;
  readonly onProgress?: (message: string) => void;
}

interface TapSummary {
  tests: number;
  pass: number;
  fail: number;
  skipped: number;
  crashed: boolean;
}

export function parseTap(output: string, exitCode: number | null): TapSummary {
  const pick = (label: string): number => {
    const m = output.match(new RegExp(`^# ${label} (\\d+)`, "m"));
    return m ? Number(m[1]) : 0;
  };
  const summary = {
    tests: pick("tests"),
    pass: pick("pass"),
    fail: pick("fail"),
    skipped: pick("skipped"),
    crashed: false,
  };
  if (summary.fail === 0 && /^not ok /m.test(output)) {
    // A file-level crash (bad import, top-level throw) reports `not ok`
    // without incrementing `# fail` on some Node versions.
    summary.fail = 1;
  }
  if (summary.tests === 0 && summary.pass === 0 && summary.fail === 0 && exitCode !== 0 && exitCode !== null) {
    summary.crashed = true;
  }
  return summary;
}

function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
}

/** Refuse the production database even if it leaks into the environment. */
export function assertNotProduction(env: NodeJS.ProcessEnv): void {
  const url = env.OPENBOOKS_DB_URL ?? "";
  if (url.includes("10.0.0.85")) {
    throw new Error("mutation runner refuses the production database (10.0.0.85)");
  }
}

const NODE_MODULES_LINKS = [
  ".",
  "web",
  "schema",
  "engine",
  "packages/customization",
  "packages/emails",
  "packages/jobs",
  "packages/office",
  "packages/pdf",
  "packages/reports",
  "packages/viewspec",
];

/** Copy tracked worktree files to a scratch dir; symlink node_modules back. */
export function createScratchCopy(repoRoot: string): string {
  const scratch = mkdtempSync(join(tmpdir(), "openbooks-mutation-"));
  const files = git(repoRoot, ["ls-files", "-z"]).split("\0").filter(Boolean);
  for (const file of files) {
    if (file.includes("..")) continue;
    const src = join(repoRoot, file);
    const dest = join(scratch, file);
    try {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
    } catch {
      // Broken symlinks (host-absolute node_modules relics) and unreadable
      // files are skipped; node_modules is re-linked below.
    }
  }
  for (const dir of NODE_MODULES_LINKS) {
    const src = join(repoRoot, dir, "node_modules");
    if (!existsSync(src)) continue;
    const dest = join(scratch, dir, "node_modules");
    try {
      if (!existsSync(dirname(dest))) mkdirSync(dirname(dest), { recursive: true });
      symlinkSync(src, dest);
    } catch {
      // Already linked or unlinkable — the run will surface a real error.
    }
  }
  return scratch;
}

export function removeScratchCopy(scratch: string): void {
  rmSync(scratch, { recursive: true, force: true });
}

/** Deterministic PRNG (mulberry32) so `--sample` selects stably. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const copy = [...items];
  let state = seed >>> 0;
  const next = (): number => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    const a = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = a;
  }
  return copy;
}

export function selectMutants(mutants: readonly GeneratedMutant[], sample: number): GeneratedMutant[] {
  const ordered = [...mutants].sort((a, b) => (a.key < b.key ? -1 : 1));
  if (sample <= 0 || ordered.length <= sample) return ordered;
  return shuffled(ordered, 0x0c10c).slice(0, sample);
}

function childEnv(repoRoot: string, useDb: boolean): NodeJS.ProcessEnv {
  void repoRoot;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    FORCE_COLOR: "0",
    OPENBOOKS_DATA_KEY:
      process.env.OPENBOOKS_DATA_KEY ??
      "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
    OPENBOOKS_TRUSTED_TEST_BYPASS: "1",
  };
  if (!useDb || !process.env.OPENBOOKS_DB_URL) {
    env.OPENBOOKS_DB_URL = "";
  }
  return env;
}

function testArgs(useDb: boolean): string[] {
  const args = [...(process.platform === "darwin"
    ? ["--no-concurrent-sparkplug", "--no-concurrent-recompilation"]
    : []),
  "--import", "tsx",
  ...(useDb ? ["--import", "./engine/src/testing/database-bypass.ts"] : []),
  "--test", "--test-force-exit", "--test-reporter=tap"];
  return args;
}

interface TestRun {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

function runTestFiles(
  scratch: string,
  files: readonly string[],
  useDb: boolean,
  timeoutSecs: number,
): Promise<TestRun> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...testArgs(useDb), ...files], {
      cwd: scratch,
      env: childEnv(scratch, useDb),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already exited.
        }
      }, 5000);
    }, timeoutSecs * 1000);
    timer.unref?.();
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ output, exitCode: code, timedOut, durationMs: Date.now() - started });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ output, exitCode: 1, timedOut, durationMs: Date.now() - started });
    });
  });
}

async function syntaxGate(mutatedSource: string): Promise<string | null> {
  let ts: typeof import("typescript");
  try {
    ts = await import("typescript");
  } catch {
    return null;
  }
  const { transpileModule, DiagnosticCategory } = ts;
  const { diagnostics } = transpileModule(mutatedSource, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext },
    reportDiagnostics: true,
  });
  const errors = (diagnostics ?? []).filter((d) => d.category === DiagnosticCategory.Error);
  if (errors.length === 0) return null;
  return errors
    .slice(0, 3)
    .map((d) => `TS${d.code}: ${typeof d.messageText === "string" ? d.messageText : d.messageText.messageText}`)
    .join("; ");
}

function verdictFor(summary: TapSummary, timedOut: boolean): { status: MutantStatus; detail: string } {
  if (timedOut) return { status: "timed-out", detail: "mutant run exceeded its time budget" };
  if (summary.fail > 0) {
    return { status: "killed", detail: `${summary.fail} failing test(s), ${summary.pass} passing` };
  }
  if (summary.pass > 0) {
    return { status: "survived", detail: `${summary.pass} passing, none failing` };
  }
  if (summary.crashed) {
    return { status: "error", detail: "test process crashed before executing any test" };
  }
  return { status: "skipped", detail: "zero tests executed (self-skipped without a database?)" };
}

async function runTarget(
  scratch: string,
  target: MutationTargetConfig,
  options: RunMutationOptions,
): Promise<TargetResult> {
  const log = options.onProgress ?? ((): void => {});
  const pristine = readFileSync(join(scratch, target.path), "utf8");
  const empty: TargetResult = {
    target: target.path, status: "measured", needsDb: target.needsDb === true,
    killed: 0, survived: 0, timedOut: 0, skipped: 0, error: 0,
    total: 0, measured: 0, ratio: null, baselineFiles: [], mutants: [],
  };

  // Baseline: every mapped file individually, so one bad file cannot poison
  // the verdict, and files that self-skip (no DB) are known up front.
  const baselineFiles: BaselineFile[] = [];
  for (const file of target.tests) {
    const run = await runTestFiles(scratch, [file], options.useDb, options.timeoutSecs);
    const summary = parseTap(run.output, run.exitCode);
    if (run.timedOut || summary.fail > 0 || summary.crashed) {
      const failed: BaselineFile = {
        file, tests: summary.tests, pass: summary.pass, fail: summary.fail,
        skipped: summary.skipped, executed: summary.pass + summary.fail > 0,
      };
      // Without a database a red baseline on a needsDb target only proves
      // the file needs the database (e.g. a test that issues a real query
      // instead of self-skipping). Report it as skipped-with-cause; the DB
      // run delivers the real verdict. In db mode a red baseline blocks.
      if (!options.useDb && target.needsDb === true) {
        return { ...empty, status: "baseline-skipped", baselineFiles: [...baselineFiles, failed] };
      }
      return { ...empty, status: "baseline-failed", baselineFiles: [...baselineFiles, failed] };
    }
    baselineFiles.push({
      file, tests: summary.tests, pass: summary.pass, fail: summary.fail,
      skipped: summary.skipped, executed: summary.pass + summary.fail > 0,
    });
  }
  const runnable = baselineFiles.filter((f) => f.executed).map((f) => f.file);
  if (runnable.length === 0) {
    return { ...empty, status: "baseline-skipped", baselineFiles };
  }

  const mutants = selectMutants(
    generateMutants(target.path, pristine, {
      ...(target.lineRanges ? { lineRanges: target.lineRanges } : {}),
      ...(options.maxPerOperator !== undefined ? { maxPerOperator: options.maxPerOperator } : {}),
    }),
    options.sample,
  );
  if (mutants.length === 0) {
    return { ...empty, status: "no-mutants", baselineFiles };
  }

  const results: MutantResult[] = [];
  for (const mutant of mutants) {
    log(`  ${mutant.key} :: ${mutant.description}`);
    const gateError = await syntaxGate(mutant.mutatedSource);
    if (gateError) {
      results.push({
        key: mutant.key, target: mutant.target, operator: mutant.operator,
        line: mutant.line, description: mutant.description,
        status: "error", detail: `does not parse: ${gateError}`, durationMs: 0,
      });
      continue;
    }
    writeFileSync(join(scratch, target.path), mutant.mutatedSource);
    const run = await runTestFiles(scratch, runnable, options.useDb, options.timeoutSecs);
    writeFileSync(join(scratch, target.path), pristine);
    const summary = parseTap(run.output, run.exitCode);
    const verdict = verdictFor(summary, run.timedOut);
    results.push({
      key: mutant.key, target: mutant.target, operator: mutant.operator,
      line: mutant.line, description: mutant.description,
      status: verdict.status, detail: verdict.detail, durationMs: run.durationMs,
    });
  }
  // Belt and braces: the target file is pristine no matter how the loop ends.
  writeFileSync(join(scratch, target.path), pristine);

  let killed = 0;
  let survived = 0;
  let timedOut = 0;
  let skipped = 0;
  let error = 0;
  for (const r of results) {
    if (r.status === "killed") killed += 1;
    else if (r.status === "survived") survived += 1;
    else if (r.status === "timed-out") timedOut += 1;
    else if (r.status === "skipped") skipped += 1;
    else error += 1;
  }
  const measured = killed + survived + timedOut;
  return {
    ...empty, baselineFiles,
    killed, survived, timedOut, skipped, error,
    total: results.length, measured,
    ratio: measured > 0 ? (killed + timedOut) / measured : null,
    mutants: results,
  };
}

/** Run every selected target against one scratch copy; resolves the report. */
export async function runMutationTargets(options: RunMutationOptions): Promise<MutationReport> {
  assertNotProduction(process.env);
  const repoRoot = resolve(options.repoRoot);
  const gitSha = sourceSha(repoRoot);
  const dirtyTargets: string[] = [];
  try {
    const dirty = git(repoRoot, ["status", "--short", ...options.targets.map((t) => t.path)]);
    for (const line of dirty.split("\n")) {
      const name = line.slice(3).trim();
      if (name) dirtyTargets.push(name);
    }
  } catch {
    // Non-fatal provenance detail.
  }
  const scratch = createScratchCopy(repoRoot);
  const log = options.onProgress ?? ((): void => {});
  try {
    const targets: TargetResult[] = [];
    for (const target of options.targets) {
      log(`target ${target.path}`);
      targets.push(await runTarget(scratch, target, options));
    }
    return {
      version: 1, gitSha, runId: runId(), casesSha256: caseDigest(targets),
      dirtyTargets, at: new Date().toISOString(),
      mode: options.useDb ? "db" : "unit",
      sample: options.sample, timeoutSecs: options.timeoutSecs, targets,
    };
  } finally {
    removeScratchCopy(scratch);
  }
}
