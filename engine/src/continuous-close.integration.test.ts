import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass, withBypassContext } from "./db.ts";
import { runDueContinuousCloseAgents } from "./continuous-close.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "./test-fixtures.ts";

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
