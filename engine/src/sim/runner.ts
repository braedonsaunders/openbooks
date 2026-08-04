import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { db, withOrgContext } from "../db.ts";
import { withSimClock } from "../clock.ts";
import { Rng } from "./rng.ts";
import { provisionOrg } from "./world.ts";
import { getProfile } from "./profiles/index.ts";
import { generateDay, type DayEvents } from "./generator.ts";
import { cheapInvariants, fullInvariants, immutabilityProbe, writeDefectBundle, type InvariantResult } from "./invariants/index.ts";
import {
  newManifest,
  readManifest,
  writeManifest,
  readWorld,
  writeWorld,
  runDirFor,
  addDays,
  isMonthEnd,
  recordCoverage,
  type RunManifest,
} from "./manifest.ts";
import type { SimContext } from "./context.ts";
import type { SimOrg } from "./world.ts";
import { autopilotDay } from "./autopilot.ts";

/**
 * Day-loop primitives. The operator (Claude Code) drives the loop: `dayStart`
 * advances the clock and injects the seeded events; persona subagents then act;
 * `dayEnd` runs the oracle and HALTS on any invariant failure by writing a
 * defect bundle. Everything is scoped to the org and pinned to the simulated
 * clock so `postedAt` and the period-driven engines advance with the run.
 */

function gitSha(): string | null {
  try { return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim(); } catch { return null; }
}

function makeContext(profileId: string, world: SimOrg, manifest: RunManifest, simDate: string): SimContext {
  return {
    profile: getProfile(profileId),
    world,
    rng: Rng.deserialize(manifest.rngState),
    simDate,
    counters: manifest.counters,
    coverage: new Set(manifest.coverage),
    log: (msg) => console.error(`[${simDate}] ${msg}`),
  };
}

function persistContext(manifest: RunManifest, ctx: SimContext): void {
  manifest.rngState = ctx.rng.serialize();
  manifest.counters = ctx.counters;
  manifest.coverage = [...ctx.coverage].sort();
}

/**
 * Make document numbering crash-safe across resume. If a `run` process dies
 * mid-day AFTER a document insert committed but BEFORE the manifest (counter +
 * simDate) is written, the resumed day would re-issue an already-used number and
 * collide on documents_org_kind_number forever. Before generating a day, advance
 * each `seq:PREFIX` counter to at least the max number already in the ledger, so
 * the next number is always free. Must run inside an org context.
 */
async function reconcileNumberCounters(orgId: string, counters: Record<string, number>): Promise<void> {
  for (const key of Object.keys(counters)) {
    if (!key.startsWith("seq:")) continue;
    const prefix = key.slice(4);
    const r = (await db.execute(sql`
      select coalesce(max((regexp_replace(document_number, '^.*-', ''))::int), 0) as mx
        from documents
       where org_id = ${orgId} and document_number ~ ${`^${prefix}-[0-9]+$`}`)) as unknown as {
      rows: { mx: number }[];
    };
    const dbMax = Number(r.rows[0]?.mx ?? 0);
    if (dbMax > (counters[key] ?? 0)) counters[key] = dbMax;
  }
}

export interface ProvisionResult {
  runId: string;
  runDir: string;
  orgId: string;
}

/** Stand up a fresh org for a run and write its manifest + world snapshot. */
export async function provisionRun(opts: {
  profileId: string;
  seed: string;
  startDate: string;
  endDate: string;
  runsRoot: string;
}): Promise<ProvisionResult> {
  const profile = getProfile(opts.profileId);
  const world = await provisionOrg(profile, { startDate: opts.startDate, endDate: opts.endDate });
  const runId = `${opts.profileId}-${opts.seed}-${world.orgId.slice(0, 8)}`;
  const runDir = runDirFor(opts.runsRoot, runId);
  const rng = Rng.fromSeed(`${opts.profileId}:${opts.seed}`);
  const manifest = newManifest({
    runId,
    profileId: opts.profileId,
    seed: opts.seed,
    orgId: world.orgId,
    startDate: opts.startDate,
    endDate: opts.endDate,
    rngState: rng.serialize(),
  });
  writeWorld(runDir, world);
  writeManifest(runDir, manifest);
  return { runId, runDir, orgId: world.orgId };
}

export interface LoadedRun {
  manifest: RunManifest;
  world: SimOrg;
}

export function loadRun(runDir: string): LoadedRun {
  return { manifest: readManifest(runDir), world: readWorld(runDir) };
}

/**
 * Drive a deterministic run to its configured end without the CLI or an LLM
 * persona. Product sample-company provisioning uses this only when a prepared,
 * verified template is not already installed. The same day-start, canonical
 * operations, close controls, and invariant oracle used by the simulator CLI
 * remain in force.
 */
export async function autopilotRunToEnd(runDir: string): Promise<RunManifest> {
  for (;;) {
    const start = await dayStart(runDir);
    if (start.halted) {
      throw new Error(
        `sample simulation halted on ${start.simDate}: ${start.halted.failures.map((failure) => failure.invariant).join(", ")}`,
      );
    }
    if (start.done) return loadRun(runDir).manifest;

    const { manifest, world } = loadRun(runDir);
    await withSimClock(manifest.simDate, () =>
      withOrgContext(manifest.orgId, async () => {
        await autopilotDay(getProfile(manifest.profileId), world, manifest);
      }),
    );
    writeManifest(runDir, manifest);

    const end = await dayEnd(runDir);
    if (end.halted) {
      throw new Error(
        `sample simulation halted on ${end.simDate}: ${end.halted.failures.map((failure) => failure.invariant).join(", ")}`,
      );
    }
  }
}

/** Halt helper: record the defect, flag the manifest, persist. */
function halt(runDir: string, manifest: RunManifest, phase: string, result: InvariantResult): string {
  const dir = writeDefectBundle(runDir, {
    seq: manifest.defects.length + 1,
    simDate: manifest.simDate,
    profileId: manifest.profileId,
    seed: manifest.seed,
    orgId: manifest.orgId,
    phase,
    failures: result.failures,
    checkpoint: result.checkpoint,
  });
  for (const f of result.failures) manifest.defects.push({ simDate: manifest.simDate, invariant: f.invariant, dir });
  manifest.status = "halted";
  writeManifest(runDir, manifest);
  return dir;
}

export interface DayStartResult {
  simDate: string;
  events: DayEvents;
  done: boolean;
  halted?: { phase: string; dir: string; failures: InvariantResult["failures"] };
}

/** Advance one day, inject the seeded events, run cheap integrity checks. */
export async function dayStart(runDir: string): Promise<DayStartResult> {
  const { manifest, world } = loadRun(runDir);
  if (manifest.simDate >= manifest.endDate) {
    manifest.status = "completed";
    writeManifest(runDir, manifest);
    return { simDate: manifest.simDate, events: { billsArrived: 0, invoicesPrepared: 0, paymentsArrived: 0 }, done: true };
  }
  const simDate = addDays(manifest.simDate, 1);
  manifest.status = "running";

  const events = await withSimClock(simDate, () =>
    withOrgContext(manifest.orgId, async () => {
      const ctx = makeContext(manifest.profileId, world, manifest, simDate);
      // Crash-safety: never re-issue a document number already committed to the ledger.
      await reconcileNumberCounters(manifest.orgId, ctx.counters);
      const ev = await generateDay(ctx);
      persistContext(manifest, ctx);
      return ev;
    }),
  );

  manifest.simDate = simDate;
  writeManifest(runDir, manifest);

  const cheap = await withOrgContext(manifest.orgId, () => cheapInvariants(manifest.orgId));
  if (!cheap.pass) {
    const dir = halt(runDir, manifest, "day-start (generator)", cheap);
    return { simDate, events, done: false, halted: { phase: "day-start", dir, failures: cheap.failures } };
  }
  return { simDate, events, done: false };
}

export interface DayEndResult {
  simDate: string;
  ranFull: boolean;
  pass: boolean;
  halted?: { phase: string; dir: string; failures: InvariantResult["failures"] };
}

/**
 * Close out the day: cheap checks always; at a month boundary (or when a new
 * period has been closed) the full golden suite + immutability probe. HALT on
 * any failure.
 */
export async function dayEnd(runDir: string): Promise<DayEndResult> {
  const { manifest, world } = loadRun(runDir);
  const simDate = manifest.simDate;

  const cheap = await withOrgContext(manifest.orgId, () => cheapInvariants(manifest.orgId));
  if (!cheap.pass) {
    const dir = halt(runDir, manifest, "day-end (cheap)", cheap);
    return { simDate, ranFull: false, pass: false, halted: { phase: "day-end", dir, failures: cheap.failures } };
  }

  // Prove immutability for any period newly closed by the controller persona.
  const { periodStatus } = await import("./observe.ts");
  const periods = await withOrgContext(manifest.orgId, () => periodStatus(world));
  const newlyClosed = (periods as { name: string; gl_state: string }[]).filter(
    (p) => p.gl_state === "closed" && !manifest.provenClosed.includes(p.name),
  );
  for (const p of newlyClosed) {
    const period = world.periods.find((x) => x.name === p.name);
    if (!period) continue;
    const probe = await withOrgContext(manifest.orgId, () => immutabilityProbe(world, period));
    if (!probe.pass) {
      const dir = halt(runDir, manifest, "day-end (immutability)", probe);
      return { simDate, ranFull: false, pass: false, halted: { phase: "day-end", dir, failures: probe.failures } };
    }
    manifest.provenClosed.push(p.name);
    recordCoverage(manifest, "period_immutability");
  }

  let ranFull = false;
  if (isMonthEnd(simDate) || newlyClosed.length > 0) {
    ranFull = true;
    const full = await withOrgContext(manifest.orgId, () => fullInvariants(manifest.orgId, new Date().toISOString(), gitSha()));
    if (full.checkpoint) {
      manifest.lastCheckpoint = { simDate, pass: full.pass, file: join(runDir, "checkpoints", `${simDate}.json`) };
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(join(runDir, "checkpoints"), { recursive: true });
      writeFileSync(manifest.lastCheckpoint.file, JSON.stringify(full.checkpoint, null, 2));
    }
    if (!full.pass) {
      const dir = halt(runDir, manifest, "day-end (full suite)", full);
      return { simDate, ranFull, pass: false, halted: { phase: "day-end", dir, failures: full.failures } };
    }
  }

  writeManifest(runDir, manifest);
  return { simDate, ranFull, pass: true };
}

/** Re-run the day-end oracle without advancing — for confirming a fix after a halt. */
export async function verify(runDir: string): Promise<DayEndResult> {
  const { manifest } = loadRun(runDir);
  if (manifest.status === "halted") {
    // Clearing the halt is contingent on the checks below passing.
    manifest.status = "running";
    writeManifest(runDir, manifest);
  }
  return dayEnd(runDir);
}
