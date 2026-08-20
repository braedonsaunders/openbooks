import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { db, withOrgContext } from "../db.ts";
import { withSimClock } from "../clock.ts";
import { regenerateGlImpactTx, type PostingDeps } from "../posting.ts";
import { paymentControlDeps } from "../payments.ts";
import { Rng } from "./rng.ts";
import { getProfile } from "./profiles/index.ts";
import { autopilotDay } from "./autopilot.ts";
import { dayStart, dayEnd, loadRun } from "./runner.ts";
import { writeManifest, recordCoverage, type RunManifest } from "./manifest.ts";
import { writeDefectBundle, type InvariantResult } from "./invariants/index.ts";
import {
  closedPeriodJournalProbe,
  overApplicationProbe,
  postedEditProbe,
  reversalSymmetryProbe,
  voidRecreateProbe,
} from "./ops-adversarial.ts";
import type { SimOrg } from "./world.ts";

/**
 * Decade-scale endurance driver.
 *
 * Runs the standard day loop (seeded generator → deterministic autopilot →
 * invariant oracle) over an arbitrarily long window — ten fiscal years is the
 * published target — and layers on what a long horizon uniquely proves:
 *
 *  - every month is closed and every close is immutability-probed (day loop);
 *  - leap days (2028-02-29, 2032-02-29, …) and ten year-end boundaries are
 *    crossed as ordinary business days;
 *  - adversarial probes fire CONTINUOUSLY on a seeded cadence: backdating
 *    into long-closed periods, raw edits of posted documents,
 *    over-application, reversal symmetry, and void/recreate;
 *  - at the end, EVERY posted document's GL projection is regenerated through
 *    the kernel (mirror scope) and must come back byte-identical
 *    (changed: false), and the trial balance before and after the sweep must
 *    match to the cent.
 *
 * Any failure writes a defect bundle and halts, exactly like the day oracle:
 * fix the product, then resume.
 *
 * All simulated timestamps are UTC dates — the kernel resolves periods from
 * document dates, so civil-time DST transitions have no ledger meaning here
 * and are deliberately not simulated.
 */

export interface EnduranceDayResult {
  simDate: string;
  done: boolean;
  halted?: { phase: string; dir: string; failures: InvariantResult["failures"] };
  probesRun: string[];
}

/** Play one endurance day: dayStart → autopilot → adversarial probes → dayEnd. */
export async function enduranceDay(runDir: string): Promise<EnduranceDayResult> {
  const start = await dayStart(runDir);
  if (start.halted) return { simDate: start.simDate, done: false, halted: start.halted, probesRun: [] };
  if (start.done) return { simDate: start.simDate, done: true, probesRun: [] };

  const { manifest, world } = loadRun(runDir);
  await withSimClock(manifest.simDate, () =>
    withOrgContext(manifest.orgId, async () => {
      await autopilotDay(getProfile(manifest.profileId), world, manifest);
    }),
  );
  writeManifest(runDir, manifest);

  const probesRun = await runAdversarialProbes(runDir, manifest, world);
  const reloaded = loadRun(runDir).manifest;
  if (reloaded.status === "halted") {
    const last = reloaded.defects[reloaded.defects.length - 1];
    return {
      simDate: manifest.simDate,
      done: false,
      halted: { phase: "adversarial", dir: last?.dir ?? runDir, failures: [] },
      probesRun,
    };
  }

  const end = await dayEnd(runDir);
  if (end.halted) return { simDate: end.simDate, done: false, halted: end.halted, probesRun };
  return { simDate: end.simDate, done: false, probesRun };
}

/**
 * Seeded adversarial cadence: each probe fires with its own per-day draw so a
 * run is reproducible from (profile, seed) alone. Failures write a defect
 * bundle and flag the manifest halted.
 */
async function runAdversarialProbes(runDir: string, manifest: RunManifest, world: SimOrg): Promise<string[]> {
  const rng = Rng.fromSeed(`adversarial:${manifest.profileId}:${manifest.seed}:${manifest.simDate}`);
  const ran: string[] = [];

  const probes: { name: string; chance: number; run: () => Promise<InvariantResult> }[] = [
    {
      name: "adversarial_closed_journal",
      chance: 0.1,
      run: async () => {
        // Probe a RANDOM long-closed period, not merely the most recent one.
        const closed = manifest.provenClosed;
        if (closed.length === 0) return { pass: true, failures: [] };
        const period = world.periods.find((p) => p.name === closed[rng.int(0, closed.length - 1)]);
        if (!period) return { pass: true, failures: [] };
        return closedPeriodJournalProbe(world, period);
      },
    },
    { name: "adversarial_posted_edit", chance: 0.1, run: () => postedEditProbe(world) },
    { name: "adversarial_over_application", chance: 0.08, run: () => overApplicationProbe(world, manifest.simDate) },
    { name: "adversarial_reversal_symmetry", chance: 0.06, run: () => reversalSymmetryProbe(world, manifest.simDate) },
    { name: "adversarial_void_recreate", chance: 0.05, run: () => voidRecreateProbe(world, manifest.simDate) },
  ];

  for (const probe of probes) {
    if (!rng.chance(probe.chance)) continue;
    // An unexpected exception inside a probe is itself a finding — halt with
    // a defect bundle rather than crashing the (resumable) run.
    const result = await withSimClock(manifest.simDate, () =>
      withOrgContext(manifest.orgId, () => probe.run()),
    ).catch((e: unknown): InvariantResult => ({
      pass: false,
      failures: [{ invariant: probe.name, detail: `probe threw: ${(e as Error).message}` }],
    }));
    ran.push(probe.name);
    if (result.pass) {
      recordCoverage(manifest, probe.name);
      writeManifest(runDir, manifest);
      continue;
    }
    const dir = writeDefectBundle(runDir, {
      seq: manifest.defects.length + 1,
      simDate: manifest.simDate,
      profileId: manifest.profileId,
      seed: manifest.seed,
      orgId: manifest.orgId,
      phase: `adversarial (${probe.name})`,
      failures: result.failures,
    });
    for (const f of result.failures) manifest.defects.push({ simDate: manifest.simDate, invariant: f.invariant, dir });
    manifest.status = "halted";
    writeManifest(runDir, manifest);
    return ran;
  }
  return ran;
}

export interface RegenSweepResult {
  documents: number;
  /**
   * Documents whose entry was REVERSED through the governed reversal path.
   * A reversed entry is closed ledger history with no live projection to
   * regenerate (je_guard doctrine); the reversal-pair-nets-to-zero probe is
   * the invariant that covers them. Counted, never silently skipped.
   */
  reversedSkipped: number;
  changed: { documentId: string; kind: string }[];
  failures: { documentId: string; kind: string; error: string }[];
  trialBalanceBefore: string;
  trialBalanceAfter: string;
  pass: boolean;
}

/** Trial-balance fingerprint: total debits|credits|account count. */
async function tbFingerprint(orgId: string): Promise<string> {
  const r = (await db.execute<{ debits: string; credits: string; accounts: string }>(sql`
    select coalesce(sum(case when l.amount > 0 then l.amount else 0 end), 0)::text as debits,
           coalesce(sum(case when l.amount < 0 then -l.amount else 0 end), 0)::text as credits,
           count(distinct l.account_id)::text as accounts
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.status in ('posted', 'reversed')
     where l.org_id = ${orgId}`));
  const row = r.rows[0]!;
  return `${row.debits}|${row.credits}|${row.accounts}`;
}

/**
 * Regenerate EVERY posted document's GL projection in mirror scope. A decade
 * of books must replay byte-identically: any {changed: true} or error is a
 * failure, and the trial balance must be untouched.
 */
export async function regenSweep(orgId: string): Promise<RegenSweepResult> {
  const deps: PostingDeps = { ...(await paymentControlDeps(orgId)), migration: true };
  const docs = (await db.execute<{ id: string; kind: string; entry_status: string }>(sql`
    select d.id, d.kind, e.status as entry_status from documents d
      join journal_entries e on e.id = d.posted_entry_id
     where d.org_id = ${orgId} and d.status = 'posted'
     order by d.created_at`));

  const before = await tbFingerprint(orgId);
  const changed: RegenSweepResult["changed"] = [];
  const failures: RegenSweepResult["failures"] = [];
  let reversedSkipped = 0;
  for (const doc of docs.rows) {
    if (doc.entry_status === "reversed") {
      reversedSkipped++;
      continue;
    }
    try {
      const res = await db.transaction((tx) => regenerateGlImpactTx(tx, doc.id, deps, "mirror"));
      if (res.changed) changed.push({ documentId: doc.id, kind: doc.kind });
    } catch (e) {
      failures.push({ documentId: doc.id, kind: doc.kind, error: (e as Error).message });
    }
  }
  const after = await tbFingerprint(orgId);

  return {
    documents: docs.rows.length,
    reversedSkipped,
    changed,
    failures,
    trialBalanceBefore: before,
    trialBalanceAfter: after,
    pass: changed.length === 0 && failures.length === 0 && before === after,
  };
}

export interface EnduranceReport {
  runId: string;
  profileId: string;
  seed: string;
  orgId: string;
  window: { startDate: string; endDate: string };
  daysSimulated: number;
  monthsClosed: number;
  leapDaysCrossed: string[];
  yearEndsCrossed: number;
  adversarial: Record<string, number>;
  regenSweep: RegenSweepResult;
  counters: Record<string, number>;
  pass: boolean;
}

/** Build and persist the final endurance report (runs after the loop completes). */
export async function enduranceFinale(runDir: string): Promise<EnduranceReport> {
  const { manifest, world } = loadRun(runDir);

  const sweep = await withOrgContext(manifest.orgId, () => regenSweep(manifest.orgId));

  const leap: string[] = [];
  for (let y = Number(manifest.startDate.slice(0, 4)); y <= Number(manifest.endDate.slice(0, 4)); y++) {
    const feb29 = `${y}-02-29`;
    if (new Date(`${feb29}T00:00:00Z`).getUTCDate() === 29 && feb29 >= manifest.startDate && feb29 <= manifest.simDate) {
      leap.push(feb29);
    }
  }
  const yearEnds = new Set<string>();
  for (let y = Number(manifest.startDate.slice(0, 4)); y <= Number(manifest.endDate.slice(0, 4)); y++) {
    const eoy = `${y}-12-31`;
    if (eoy >= manifest.startDate && eoy <= manifest.simDate) yearEnds.add(eoy);
  }

  const adversarial: Record<string, number> = {};
  for (const [key, count] of Object.entries(manifest.counters)) {
    if (key.startsWith("adversarial_")) adversarial[key] = count;
  }

  const days =
    (Date.parse(`${manifest.simDate}T00:00:00Z`) - Date.parse(`${manifest.startDate}T00:00:00Z`)) / 86_400_000 + 1;

  const report: EnduranceReport = {
    runId: manifest.runId,
    profileId: manifest.profileId,
    seed: manifest.seed,
    orgId: manifest.orgId,
    window: { startDate: manifest.startDate, endDate: manifest.endDate },
    daysSimulated: Math.max(0, Math.round(days)),
    monthsClosed: manifest.provenClosed.length,
    leapDaysCrossed: leap,
    yearEndsCrossed: yearEnds.size,
    adversarial,
    regenSweep: sweep,
    counters: manifest.counters,
    pass: sweep.pass && manifest.status !== "halted" && world.periods.length > 0,
  };

  const dir = join(runDir, "endurance");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "endurance-report.json"), JSON.stringify(report, null, 2));
  return report;
}
