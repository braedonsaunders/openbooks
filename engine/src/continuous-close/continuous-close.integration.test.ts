import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass, withBypassContext } from "../platform/db.ts";
import {
  registerContinuousCloseEnricher,
  runContinuousCloseAgent,
  runDueContinuousCloseAgents,
} from "./continuous-close.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";

/**
 * Live-PostgreSQL durability proofs for the continuous-close scheduler
 * (runDueContinuousCloseAgents). One occurrence = one due fire time of one
 * agent policy. The claim of an occurrence must commit atomically with the
 * ai_agent_runs row that justifies it, so a crash between claiming and
 * executing loses nothing and a restart fires exactly once.
 */

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

type RunRow = {
  id: string;
  trigger: string;
  status: string;
  stats: Record<string, unknown>;
  error_code: string | null;
};

/** An enabled manual accounting policy whose model analysis is switched on. */
async function seedManualPolicy(org: ScratchOrg): Promise<void> {
  return withBypassContext(async () => {
    await db.execute(sql`
      insert into ai_agent_policies
        (id, org_id, agent_key, enabled, automatic_runs, cadence, materiality_threshold,
         detector_settings, analysis_settings, next_run_at)
      values (${randomUUID()}, ${org.orgId}, 'accounting', true, false, 'daily', '1000',
              ${JSON.stringify({})}::jsonb,
              ${JSON.stringify({ rootCauseAnalysis: true, recommendations: true, narrative: true })}::jsonb,
              null)
    `);
  });
}

async function runStatus(orgId: string, runId: string): Promise<{ status: string; stats: Record<string, unknown> }> {
  const row = (await withBypassContext(() =>
    db.execute<{ status: string; stats: Record<string, unknown> }>(sql`
      select status, stats from ai_agent_runs where id = ${runId} and org_id = ${orgId}
    `))).rows[0]!;
  return { status: row.status, stats: row.stats };
}

/** A production-env scratch org with one enabled, due daily accounting policy. */
async function seedDuePolicy(
  org: ScratchOrg,
  options: { fireAt?: Date; detectorSettings?: unknown } = {},
): Promise<string> {
  return withBypassContext(async () => {
    const id = randomUUID();
    await db.execute(sql`
      insert into ai_agent_policies
        (id, org_id, agent_key, enabled, automatic_runs, cadence, materiality_threshold,
         detector_settings, analysis_settings, next_run_at)
      values (${id}, ${org.orgId}, 'accounting', true, true, 'daily', '1000',
              ${JSON.stringify(options.detectorSettings ?? {})}::jsonb,
              ${JSON.stringify({ rootCauseAnalysis: false, recommendations: false, narrative: false })}::jsonb,
              ${options.fireAt ?? new Date(Date.now() - 60_000)})
    `);
    return id;
  });
}

async function runs(orgId: string): Promise<RunRow[]> {
  return withBypassContext(async () =>
    (await db.execute<RunRow>(sql`
      select id::text as id, trigger, status, stats, error_code as "error_code"
        from ai_agent_runs
       where org_id = ${orgId}
       order by started_at, id
    `)).rows);
}

async function scheduledRuns(orgId: string): Promise<RunRow[]> {
  return (await runs(orgId)).filter((run) => run.trigger === "scheduler");
}

async function policyCursor(orgId: string): Promise<{ nextRunAt: Date | null; lastRunAt: Date | null }> {
  const row = (await withBypassContext(() =>
    db.execute<{ next_run_at: Date | string | null; last_run_at: Date | string | null }>(sql`
      select next_run_at, last_run_at from ai_agent_policies where org_id = ${orgId}
    `))).rows[0]!;
  return {
    nextRunAt: row.next_run_at === null ? null : new Date(row.next_run_at),
    lastRunAt: row.last_run_at === null ? null : new Date(row.last_run_at),
  };
}

/**
 * Scoped forced-failure triggers — the same technique as the payment-scheduler
 * suite: raise inside the database at one exact stage boundary so a crash in
 * the claimed transaction is reproduced deterministically.
 */
async function failRunInserts(orgId: string): Promise<() => Promise<void>> {
  const suffix = orgId.replaceAll("-", "").slice(0, 12);
  const fn = `openbooks_test_fail_cc_run_${suffix}`;
  const trigger = `openbooks_test_fail_cc_run_${suffix}`;
  await db.execute(sql.raw(`
    create function public.${fn}() returns trigger
    language plpgsql as $$
    begin
      raise exception 'forced continuous-close run insert failure';
    end
    $$
  `));
  await db.execute(sql.raw(`
    create trigger ${trigger}
    before insert on public.ai_agent_runs
    for each row when (new.org_id = '${orgId}'::uuid)
    execute function public.${fn}()
  `));
  return async () => {
    await db.execute(sql.raw(`drop trigger if exists ${trigger} on public.ai_agent_runs`));
    await db.execute(sql.raw(`drop function if exists public.${fn}()`));
  };
}

test(
  "a crash at the claimed occurrence loses nothing — the next tick fires exactly once with its scheduled-for timestamp",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    let dropFailureTrigger: () => Promise<void> = () => Promise.resolve();
    try {
      const fireAt = new Date(Date.now() - 60_000);
      await seedDuePolicy(org, { fireAt });

      // Force failure exactly inside the claimed transaction: raising on the
      // first statement after the cursor claim aborts the whole unit — what a
      // process killed between claim and execution does, deterministically.
      dropFailureTrigger = await withBypass(() => failRunInserts(org.orgId));

      await runDueContinuousCloseAgents(new Date());

      // Nothing is stranded: no run row survives...
      assert.equal((await runs(org.orgId)).length, 0,
        "a crashed claim leaves no half-written run record");
      // ...and the cursor was NOT advanced — the occurrence is still due.
      const afterCrash = await policyCursor(org.orgId);
      assert.ok(afterCrash.nextRunAt && afterCrash.nextRunAt <= new Date(),
        "the crashed tick did not consume the occurrence");

      await dropFailureTrigger();
      dropFailureTrigger = () => Promise.resolve();

      // The restart must materialize exactly one durable run for the still-due
      // occurrence, carrying the fire time it was scheduled for.
      await runDueContinuousCloseAgents(new Date());
      const resumed = await scheduledRuns(org.orgId);
      assert.equal(resumed.length, 1, "exactly one scheduler run after the resume");
      assert.equal(resumed[0]!.status, "completed");
      assert.equal(resumed[0]!.stats.scheduled_for, fireAt.toISOString(),
        "the run retains its occurrence's scheduled-for timestamp");

      const recovered = await policyCursor(org.orgId);
      assert.ok(recovered.nextRunAt && recovered.nextRunAt > fireAt,
        "the cursor advanced past the fired occurrence only once it has evidence");
      assert.ok(recovered.lastRunAt, "last_run_at recorded with the committed scan");

      // The advanced cursor throttles an immediate re-tick — no second firing.
      await runDueContinuousCloseAgents(new Date());
      assert.equal((await scheduledRuns(org.orgId)).length, 1,
        "no duplicate execution once the occurrence fired");
    } finally {
      await dropFailureTrigger();
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "concurrent scheduler ticks claim one occurrence and execute exactly one scan",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const fireAt = new Date(Date.now() - 60_000);
      await seedDuePolicy(org, { fireAt });
      const now = new Date();

      await Promise.all([
        runDueContinuousCloseAgents(now),
        runDueContinuousCloseAgents(now),
      ]);

      const executed = (await scheduledRuns(org.orgId)).filter(
        (run) => run.stats.reason !== "already_running" && run.status !== "skipped",
      );
      assert.equal(executed.length, 1, "exactly one scan across racing ticks");
      assert.equal(executed[0]!.status, "completed");
      assert.equal(executed[0]!.stats.scheduled_for, fireAt.toISOString());

      const cursor = await policyCursor(org.orgId);
      assert.ok(cursor.nextRunAt && cursor.nextRunAt > fireAt,
        "the winner's cursor advance survived the race");
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "a true detector failure stays durably failed — recorded once, never silently skipped",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const fireAt = new Date(Date.now() - 60_000);
      // An unsafe detector configuration throws while normalizing inside the
      // claimed transaction — a deterministic stand-in for any broken detector
      // query throwing mid-scan.
      await seedDuePolicy(org, {
        fireAt,
        detectorSettings: { stale_accounting_documents: { parameters: { staleAfterDays: 0 } } },
      });

      await runDueContinuousCloseAgents(new Date());

      const failed = await scheduledRuns(org.orgId);
      assert.equal(failed.length, 1, "the failed scan has its own durable record");
      assert.equal(failed[0]!.status, "failed", "detector failure is recorded as failed");
      assert.equal(failed[0]!.error_code, "detector_failed");
      assert.equal(failed[0]!.stats.scheduled_for, fireAt.toISOString(),
        "even a failure keeps the occurrence's scheduled-for timestamp");

      const cursor = await policyCursor(org.orgId);
      assert.ok(cursor.nextRunAt && cursor.nextRunAt > fireAt,
        "the failing attempt consumed exactly its own cadence slot");

      // An immediate re-tick neither retries nor doubles: the slot was consumed
      // by one loud, visible failed record.
      await runDueContinuousCloseAgents(new Date());
      const afterRetick = await scheduledRuns(org.orgId);
      assert.equal(afterRetick.length, 1,
        "an immediate re-tick adds nothing — the failure is durably accounted for");
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "a second scan is refused while the first run is still enriching",
  { skip: !DB },
  async () => {
    // The defect: the first run flipped to 'completed' before its
    // network-bound enrichment, so a second scan during the model call was
    // admitted, refreshed the same fingerprints, and the first enrichment's
    // work-item UPDATEs matched zero rows — silently discarding its
    // analysis. The run must stay 'running' (the overlap lease) until
    // enrichment appends and releases it.
    const org = await withBypass(() => createScratchOrg());
    let releaseEnricher!: () => void;
    const enricherGate = new Promise<void>((resolve) => { releaseEnricher = resolve; });
    const enricherEntered = new Promise<{ runId: string }>((resolve) => {
      let calls = 0;
      registerContinuousCloseEnricher(async (input) => {
        calls += 1;
        // Only the first enrichment pauses: a second admitted scan would
        // call the enricher again, and the test must observe that admission
        // (as a skipped refusal) instead of deadlocking on the same gate.
        if (calls === 1) {
          resolve({ runId: input.runId });
          await enricherGate;
        }
        return { status: "completed", analyzedFindings: 0 };
      });
    });
    try {
      await seedManualPolicy(org);

      const first = runContinuousCloseAgent({ orgId: org.orgId, agentKey: "accounting", trigger: "manual" });
      const { runId: firstRunId } = await enricherEntered;

      // The detectors committed but enrichment is paused: the lease is held.
      assert.equal((await runStatus(org.orgId, firstRunId)).status, "running",
        "the first run stays running while it enriches");

      const second = await runContinuousCloseAgent({ orgId: org.orgId, agentKey: "accounting", trigger: "manual" });
      assert(second.status === "skipped", "the overlapping scan is refused");
      const secondRow = await runStatus(org.orgId, second.runId);
      assert.equal((secondRow.stats as { reason: string }).reason, "already_running");
      assert.equal((secondRow.stats as { activeRunId: string }).activeRunId, firstRunId,
        "the refusal names the run still holding the lease");

      releaseEnricher();
      const completed = await first;
      assert.equal(completed.status, "completed");
      const finalRow = await runStatus(org.orgId, firstRunId);
      assert.equal(finalRow.status, "completed", "the lease releases after enrichment");
      assert.equal(
        (finalRow.stats as { enrichment: { status: string; analyzedFindings: number } }).enrichment.status,
        "completed",
      );
      assert.equal(
        (finalRow.stats as { enrichment: { status: string; analyzedFindings: number } }).enrichment.analyzedFindings,
        0,
        "only the enricher's own applied count is reported — nothing invented",
      );
    } finally {
      registerContinuousCloseEnricher(null);
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "a crashed run's lease expires and is reclaimed instead of blocking scans forever",
  { skip: !DB },
  async () => {
    // A process killed mid-enrichment leaves a 'running' row. The next scan
    // must proceed once the lease is stale, and the abandoned row must be
    // marked failed with its abandonment on the record — never left
    // 'running' forever, never silently reused.
    const org = await withBypass(() => createScratchOrg());
    try {
      await seedManualPolicy(org);
      const staleRunId = randomUUID();
      await withBypassContext(() => db.execute(sql`
        insert into ai_agent_runs (id, org_id, agent_key, trigger, status, detector_version, started_at)
        values (${staleRunId}, ${org.orgId}, 'accounting', 'manual', 'running', 'test', now() - interval '1 hour')
      `));

      const result = await runContinuousCloseAgent({ orgId: org.orgId, agentKey: "accounting", trigger: "manual" });
      assert.equal(result.status, "completed", "the scan proceeds once the stale lease expired");

      const stale = await runStatus(org.orgId, staleRunId);
      assert.equal(stale.status, "failed", "the abandoned lease is reclaimed as failed");
      assert.equal((stale.stats as { reason: string }).reason, "abandoned_lease_reclaimed");
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);
