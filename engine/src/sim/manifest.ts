import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SimOrg } from "./world.ts";

/**
 * The resumable run state. Written after every committed simulated day so a run
 * can be paused and resumed exactly: the DB already holds the committed
 * activity, and this file holds the cursor + RNG state to continue from.
 */
export interface RunManifest {
  /** Format version so older run dirs are detected, not silently misread. */
  version: 1;
  runId: string;
  profileId: string;
  seed: string;
  /** The provisioned org this run drives. */
  orgId: string;
  /** Inclusive simulation window (YYYY-MM-DD). */
  startDate: string;
  endDate: string;
  /** The last simulated day fully committed. Resume continues the day after. */
  simDate: string;
  /** Master RNG state (Rng.serialize) as of `simDate`. */
  rngState: string;
  /** Monotonic counters for a human progress read-out. */
  counters: Record<string, number>;
  /** Capability keys exercised at least once (the coverage matrix). */
  coverage: string[];
  /** Summary of the most recent per-period invariant checkpoint. */
  lastCheckpoint: { simDate: string; pass: boolean; file: string } | null;
  /** Period names whose closed-period immutability has already been proven. */
  provenClosed: string[];
  /** Defects surfaced (and whether the run halted on them). */
  defects: { simDate: string; invariant: string; dir: string }[];
  status: "running" | "paused" | "halted" | "completed";
}

/** The provisioned org handle, persisted so a run can be resumed without re-deriving it. */
export function writeWorld(runDir: string, world: SimOrg): void {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "world.json"), JSON.stringify(world, null, 2));
}
export function readWorld(runDir: string): SimOrg {
  return JSON.parse(readFileSync(join(runDir, "world.json"), "utf8")) as SimOrg;
}

function manifestPath(runDir: string): string {
  return join(runDir, "manifest.json");
}

export function runDirFor(runsRoot: string, runId: string): string {
  return join(runsRoot, runId);
}

export function writeManifest(runDir: string, manifest: RunManifest): void {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(manifestPath(runDir), JSON.stringify(manifest, null, 2));
}

export function readManifest(runDir: string): RunManifest {
  const raw = readFileSync(manifestPath(runDir), "utf8");
  const m = JSON.parse(raw) as RunManifest;
  if (m.version !== 1) throw new Error(`unsupported run manifest version: ${String(m.version)}`);
  return m;
}

export function newManifest(args: {
  runId: string;
  profileId: string;
  seed: string;
  orgId: string;
  startDate: string;
  endDate: string;
  rngState: string;
}): RunManifest {
  return {
    version: 1,
    runId: args.runId,
    profileId: args.profileId,
    seed: args.seed,
    orgId: args.orgId,
    startDate: args.startDate,
    endDate: args.endDate,
    // Before the first day runs, the cursor sits one day before the start.
    simDate: addDays(args.startDate, -1),
    rngState: args.rngState,
    counters: {},
    coverage: [],
    lastCheckpoint: null,
    provenClosed: [],
    defects: [],
    status: "running",
  };
}

// --- small, dependency-free date helpers on YYYY-MM-DD (UTC) ----------------

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function isWeekend(isoDate: string): boolean {
  const dow = new Date(`${isoDate}T00:00:00.000Z`).getUTCDay();
  return dow === 0 || dow === 6;
}

export function dayOfMonth(isoDate: string): number {
  return Number(isoDate.slice(8, 10));
}

export function isMonthEnd(isoDate: string): boolean {
  return addDays(isoDate, 1).slice(5, 7) !== isoDate.slice(5, 7);
}

export function isYearEnd(isoDate: string): boolean {
  return isoDate.slice(5) === "12-31";
}

export function monthKey(isoDate: string): string {
  return isoDate.slice(0, 7);
}

/** Generate the inclusive list of dates from start..end. */
export function eachDay(start: string, end: string): string[] {
  const out: string[] = [];
  let cur = start;
  while (cur <= end) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}
