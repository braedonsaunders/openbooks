import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { withOrgContext } from "../db.ts";
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
  type RunManifest,
} from "./manifest.ts";
import type { SimContext } from "./context.ts";
import type { SimOrg } from "./world.ts";

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
