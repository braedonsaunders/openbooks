import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "./db.ts";
import { WEB_TICK_LOCK_KEY, withTickClaim } from "./scheduler-lock.ts";
import {
  computeScheduledScriptNextRunAt,
  InvalidScheduledScriptCronError,
  quarantineInvalidScheduledScript,
  runScheduledScript,
} from "./scripting.ts";

/**
 * Scheduled-script runner — a real cron-driven loop that polls every 60 s for
 * active scheduled scripts whose next_run_at has passed, runs them, and
 * advances next_run_at to the next cron tick.
 *
 * Durability contract (one occurrence = one due cron tick of one script):
 *
 *   CLAIM   — advancing the cursor and inserting the durable dispatch-ledger
 *             row (a `script_runs` row with target_kind 'scheduled_occurrence',
 *             status 'queued') happen in ONE statement. A process crash after
 *             commit therefore leaves the occurrence queued in the database,
 *             never silently skipped; the old claim-then-dispatch window that
 *             could lose an occurrence is gone.
 *   DISPATCH — Redis enqueue (jobId = the deterministic occurrence key) or,
 *             when Redis is unavailable, an inline run share that identity;
 *             the ledger row records every attempt and mirrors the terminal
 *             outcome ('ok' | 'aborted' | 'error' | 'timeout').
 *   RECOVERY — each tick reconciles stale ledger rows: worker-written
 *             `script_runs` evidence closes the occurrence, a lost first
 *             dispatch is retried exactly once (status 'dispatch_retry'), and
 *             a retry that still produced no evidence is stamped as a terminal
 *             'error' loss instead of being retried forever.
 *
 * Concurrency: the UPDATE … WHERE next_run_at = $old guard inside the claim
 * CTE serializes concurrent scanners across replicas — exactly one wins each
 * occurrence; losers observe an empty claim and move on. The module-local
 * `running` flag only stops overlap within one process.
 *
 * Cross-replica: the whole tick is claimed with the same session-level Postgres
 * advisory lock primitive the report scheduler uses (engine/src/scheduler-lock.ts),
 * under this topology's own WEB_TICK_LOCK_KEY. Every Next.js replica calls
 * ensureScheduler, so without the claim N replicas would each run SFTP imports,
 * bank feeds, and every other global scan on each 60 s boundary — multiplied
 * provider/storage traffic and nondeterministic operational evidence. The claim
 * is per-topology: it never suppresses the worker's distinct duties, and the
 * per-duty CAS/lease claims below stay as the fine-grained safety net for any
 * duty shared with another topology.
 */

const TICK_INTERVAL_MS = 60_000;
/** A queued occurrence older than this is considered orphaned by its claimer. */
const OCCURRENCE_STALE_MS = 15 * 60_000;
/** Initial dispatch + exactly one recovery retry; then the loss is terminal. */
const MAX_OCCURRENCE_ATTEMPTS = 2;
const RECOVERY_BATCH = 50;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export function ensureScheduler(): void {
  if (timer) return;
  timer = setInterval(tick, TICK_INTERVAL_MS);
  timer.unref?.();
  tick();
}

export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export interface DueScript {
  id: string;
  orgId: string;
  cron: string | null;
  nextRunAt: Date;
}

interface OccurrenceEvent {
  [key: string]: unknown;
}

interface ClaimedOccurrence {
  /** The script_runs ledger row id. */
  id: string;
  orgId: string;
  scriptId: string;
  /** Deterministic identity shared by the Redis jobId and the ledger row. */
  occurrenceKey: string;
}

/**
 * The occurrence identity for one scheduled run: stable across processes and
 * across Redis/database boundaries, so the queue job, the ledger row, and any
 * recovery all refer to the same occurrence.
 */
export function scriptOccurrenceKey(scriptId: string, scheduledFor: Date | string): string {
  return `sched|${scriptId}|${asDbDate(scheduledFor).toISOString()}`;
}

/** Raw `db.execute` timestamps arrive as Date or driver text depending on path. */
function asDbDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

async function appendOccurrenceEvents(id: string, events: OccurrenceEvent[]): Promise<void> {
  if (events.length === 0) return;
  await withBypassContext(() =>
    db.execute(sql`
      update script_runs
         set logs = logs || ${JSON.stringify(events)}::jsonb
       where id = ${id}
    `));
}

async function finalizeOccurrence(
  id: string,
  status: "ok" | "aborted" | "error" | "timeout",
  errorMessage: string | null,
  durationMs: number | null,
  event: OccurrenceEvent,
): Promise<boolean> {
  const finalized = await withBypassContext(() =>
    db.execute(sql`
      update script_runs
         set status = ${status},
             error_message = ${errorMessage},
             duration_ms = ${durationMs},
             logs = logs || ${JSON.stringify([event])}::jsonb
       where id = ${id} and status in ('queued', 'dispatch_retry')
    `));
  return (finalized.rowCount ?? 0) === 1;
}

/**
 * Claim one due occurrence: advance the cron cursor AND insert the durable
 * ledger row in the same statement. The WHERE next_run_at = $old guard means
 * only one claimer wins; the CTE guarantees the cursor advance and the queued
 * occurrence commit together or not at all.
 */
export async function claimDueScriptOccurrence(s: DueScript): Promise<ClaimedOccurrence | null> {
  let next: Date;
  try {
    next = computeScheduledScriptNextRunAt(s.cron);
  } catch (error) {
    if (!(error instanceof InvalidScheduledScriptCronError)) throw error;
    // No occurrence is claimed and no source is dispatched. The CAS inside
    // quarantineInvalidScheduledScript means a concurrent admin repair wins
    // cleanly instead of being overwritten by this stale scan result.
    await withBypassContext(() =>
      quarantineInvalidScheduledScript({
        id: s.id,
        orgId: s.orgId,
        cron: s.cron,
        nextRunAt: s.nextRunAt,
      }),
    );
    return null;
  }
  const occurrenceKey = scriptOccurrenceKey(s.id, s.nextRunAt);
  const scheduledForIso = asDbDate(s.nextRunAt).toISOString();
  const claimed = await withBypassContext(() =>
    db.execute<{ id: string }>(sql`
      with advanced as (
        update user_scripts
           set next_run_at = ${next}
         where id = ${s.id} and org_id = ${s.orgId} and next_run_at = ${s.nextRunAt}
        returning id
      )
      insert into script_runs (org_id, script_id, target_kind, target_id, status, logs, at)
      select ${s.orgId}, ${s.id}, 'scheduled_occurrence', null, 'queued',
             jsonb_build_array(jsonb_build_object(
               'event', 'claimed',
               'occurrence', ${occurrenceKey}::text,
               'scheduledFor', ${scheduledForIso}::text,
               'attempt', 1)),
             ${s.nextRunAt}
      from advanced
      returning id
    `));
  const row = claimed.rows[0];
  if (!row) return null;
  return { id: row.id, orgId: s.orgId, scriptId: s.id, occurrenceKey };
}

/**
 * Dispatch one claimed occurrence. Attempt 1 uses the bare occurrence key as
 * the BullMQ jobId; recovery retries use a suffixed key because a superseded
 * failed job with the original id would otherwise dedup the retry away. When
 * Redis is down the run happens inline in this process under the same
 * identity. A terminal outcome (or a final-attempt host failure) is mirrored
 * onto the ledger row; an earlier host failure stays open for recovery.
 */
async function dispatchScriptOccurrence(
  occ: ClaimedOccurrence,
  attempt: number,
): Promise<void> {
  const jobId = attempt === 1 ? occ.occurrenceKey : `${occ.occurrenceKey}:r${attempt}`;
  let enqueued = false;
  try {
    const { enqueueScriptRun } = await import("@openbooks/jobs");
    await enqueueScriptRun({ orgId: occ.orgId, scriptId: occ.scriptId, kind: "scheduled" }, { jobId });
    enqueued = true;
  } catch {
    /* Redis unavailable — fall through to inline */
  }
  if (enqueued) {
    await appendOccurrenceEvents(occ.id, [{ event: "enqueued", job: jobId, attempt }]);
    return;
  }
  try {
    const outcome = await withOrgContext(occ.orgId, () => runScheduledScript(occ.scriptId, occ.orgId));
    await finalizeOccurrence(
      occ.id,
      outcome.status,
      outcome.status === "ok" ? null : outcome.abortReason ?? null,
      outcome.durationMs,
      { event: "ran_inline", job: jobId, attempt },
    );
  } catch (e) {
    // runScheduledScript writes its own script_runs row for script failures;
    // this catches host-side failures (db insert, feature gate, missing row).
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 1000);
    if (attempt < MAX_OCCURRENCE_ATTEMPTS) {
      await appendOccurrenceEvents(occ.id, [{ event: "dispatch_failed", error: message, attempt }]);
      console.error(`[scheduler] script ${occ.scriptId} dispatch failed (attempt ${attempt}); recovery will retry:`, e);
      return;
    }
    await finalizeOccurrence(occ.id, "error", `scheduled occurrence lost after final attempt: ${message}`, null, {
      event: "lost",
      attempt,
    });
    console.error(`[scheduler] script ${occ.scriptId} occurrence ${occ.occurrenceKey} lost after final attempt:`, e);
  }
}

/**
 * Org-less scan for due scheduled scripts. "Org-less" is a statement about
 * SCOPE, not authority: the scan crosses an explicit trusted boundary, while
 * the script itself runs inside its own tenant. This scan runs from a bare
 * timer callback with no request store, so without that boundary the
 * connection layer applies its deny-by-default GUCs and the scan returns zero
 * rows and no error — every scheduled script would silently stop firing.
 */
export async function scanDueScripts(): Promise<DueScript[]> {
  // NOTE: this org-less scan needs a supporting index on user_scripts with
  // column order (trigger_point, is_active, next_run_at).
  const due = await withBypassContext(() =>
    db.execute<{ id: string; orgId: string; cron: string | null; nextRunAt: Date | string }>(sql`
      select script.id, script.org_id as "orgId", script.cron, script.next_run_at as "nextRunAt"
        from user_scripts script
        join orgs organization on organization.id = script.org_id
       where script.trigger_point = 'scheduled'
         and script.is_active
         and script.next_run_at <= now()
         and organization.env_kind = 'production'
         and organization.settings #>> '{features,scripts}' = 'true'
       order by next_run_at
    `));
  return due.rows.map((row) => ({ ...row, nextRunAt: asDbDate(row.nextRunAt) }));
}

/** Claim and dispatch every due scheduled-script occurrence. */
export async function runDueScripts(): Promise<void> {
  for (const s of await scanDueScripts()) {
    const occ = await claimDueScriptOccurrence(s);
    if (!occ) continue; // someone else claimed it (or it changed)
    await dispatchScriptOccurrence(occ, 1);
  }
}

/**
 * Reconcile dispatch-ledger rows after crashes and lost races:
 *   1. mirror worker-written terminal evidence onto stale open occurrences;
 *   2. stamp a terminal loss on twice-attempted occurrences without evidence;
 *   3. re-dispatch orphaned first attempts exactly once ('dispatch_retry').
 * Only occurrences stale past OCCURRENCE_STALE_MS participate, so live
 * dispatches are never raced by recovery.
 */
export async function recoverLostScriptOccurrences(now = new Date()): Promise<void> {
  const staleBefore = new Date(now.getTime() - OCCURRENCE_STALE_MS);

  // 1) A real scheduled-run row written since the claim is terminal evidence.
  //    Only the OLDEST open occurrence of a script may absorb it, so two open
  //    occurrences can never consume each other's evidence. The lateral join
  //    lives inside the CTE because PostgreSQL forbids an UPDATE ... FROM item
  //    from referencing the update target (42P10); as an ordinary FROM item
  //    the same correlated lookup is legal, and the statement stays atomic.
  await withBypassContext(() =>
    db.execute(sql`
      with evidence as (
        select occ.id,
               run.status,
               run.error_message,
               run.duration_ms
          from script_runs occ
          join lateral (
            select r.status, r.error_message, r.duration_ms
              from script_runs r
             where r.script_id = occ.script_id
               and r.org_id = occ.org_id
               and r.target_kind = 'scheduled'
               and r.at >= occ.at
             order by r.at desc
             limit 1
          ) run on true
         where occ.target_kind = 'scheduled_occurrence'
           and occ.status in ('queued', 'dispatch_retry')
           and occ.at < ${staleBefore}
           and not exists (
             select 1
               from script_runs newer
              where newer.script_id = occ.script_id
                and newer.org_id = occ.org_id
                and newer.target_kind = 'scheduled_occurrence'
                and newer.at > occ.at
                and newer.status in ('queued', 'dispatch_retry'))
      )
      update script_runs occ
         set status = evidence.status,
             error_message = evidence.error_message,
             duration_ms = evidence.duration_ms,
             logs = occ.logs || ${JSON.stringify([{ event: "completed_on_worker" }])}::jsonb
        from evidence
       where occ.id = evidence.id
    `));

  // 2) An occurrence that already consumed its single retry and still shows no
  //    terminal evidence is a loss: stamp it visibly instead of retrying
  //    forever (scripts can create governed journals — double-firing is worse
  //    than a loud, durable miss).
  await withBypassContext(() =>
    db.execute(sql`
      update script_runs
         set status = 'error',
             error_message = 'scheduled occurrence lost: no terminal evidence after retry',
             logs = logs || ${JSON.stringify([{ event: "lost" }])}::jsonb
       where target_kind = 'scheduled_occurrence'
         and status = 'dispatch_retry'
         and at < ${staleBefore}
    `));

  // 3) Retry orphaned first attempts exactly once. The CAS on status keeps a
  //    concurrent completion (step 1 of a parallel tick) from being overwritten.
  const stale = await withBypassContext(() =>
    db.execute<{ id: string; orgId: string; scriptId: string; at: Date | string }>(sql`
      select id, org_id as "orgId", script_id as "scriptId", at
        from script_runs
       where target_kind = 'scheduled_occurrence'
         and status = 'queued'
         and at < ${staleBefore}
       order by at
       limit ${RECOVERY_BATCH}
    `));
  for (const row of stale.rows) {
    const transitioned = await withBypassContext(() =>
      db.execute(sql`
        update script_runs
           set status = 'dispatch_retry',
               logs = logs || ${JSON.stringify([{ event: "recover", attempt: MAX_OCCURRENCE_ATTEMPTS }])}::jsonb
         where id = ${row.id} and status = 'queued'
      `));
    if (!transitioned.rowCount) continue; // evidence landed concurrently
    await dispatchScriptOccurrence(
      {
        id: row.id,
        orgId: row.orgId,
        scriptId: row.scriptId,
        occurrenceKey: scriptOccurrenceKey(row.scriptId, row.at),
      },
      MAX_OCCURRENCE_ATTEMPTS,
    );
  }
}

export async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // One cross-replica claim around the ENTIRE scan set: a replica that loses
    // the race skips every duty below, not merely one subsystem.
    await withTickClaim(WEB_TICK_LOCK_KEY, async () => {
      await recoverLostScriptOccurrences();
      await runDueScripts();

      // Inbound SFTP bank feeds: scan watch folders and import new statement files.
      try {
        const { runDueSftpImports } = await import("./sftp/import-job.ts");
        await runDueSftpImports();
      } catch (e) {
        console.error("[scheduler] sftp import scan failed:", e);
      }

      // Live bank feeds (Plaid / GoCardless / TrueLayer): pull each due connection
      // and import through the same statement pipeline. Claimed per-connection.
      try {
        const { runDueBankFeeds } = await import("./bank-feed-providers.ts");
        await runDueBankFeeds();
      } catch (e) {
        console.error("[scheduler] bank feed sync failed:", e);
      }

      // Tenant-configured payment schedules: create draft runs or submit them.
      try {
        const { runDuePaymentSchedules } = await import("./payment-operations.ts");
        await runDuePaymentSchedules();
      } catch (e) {
        console.error("[scheduler] payment schedule scan failed:", e);
      }

      // Recurring documents: clone each due template into a fresh draft (and post
      // it when the schedule is set to auto-post). Self-throttles on next_run_on.
      try {
        const { runDueRecurringSchedules } = await import("./recurring.ts");
        await runDueRecurringSchedules();
      } catch (e) {
        console.error("[scheduler] recurring billing scan failed:", e);
      }

      // Dunning, subscription/property billing, FX scans, and approval
      // escalations go through scheduler_outbox (claim / run / fail+reason /
      // backoff). A crash leaves the row — Redis is not the source of truth.
      try {
        const { ensureScanOutboxRows, processDueSchedulerOutbox } = await import("./scheduler-outbox.ts");
        await withBypassContext(() => ensureScanOutboxRows());
        const { processGateTimers } = await import("./flows/gates.ts");
        await processGateTimers();
        await withBypassContext(() => processDueSchedulerOutbox());
        const { processDuePostingEffects } = await import("./posting-effects.ts");
        await withBypassContext(() => processDuePostingEffects());
      } catch (e) {
        console.error("[scheduler] durable outbox tick failed:", e);
      }

      // Flows: scheduled triggers (durable per-occurrence claims beside the
      // cron cursor on flows.last_scheduled_run_at). Recovery re-fires claims
      // orphaned by a crash before runDueScheduledFlows scans new ones.
      try {
        const { recoverLostScheduledFlows, runDueScheduledFlows } = await import("./flows/scheduled.ts");
        await withBypassContext(() => recoverLostScheduledFlows());
        await runDueScheduledFlows();
      } catch (e) {
        console.error("[scheduler] scheduled flows scan failed:", e);
      }

      // Period close: expire temporary reopen windows and execute deadline rules.
      try {
        const { recloseExpiredReopens, runDueCloseAutomations } = await import("./close.ts");
        await recloseExpiredReopens();
        await runDueCloseAutomations();
      } catch (e) {
        console.error("[scheduler] close automation scan failed:", e);
      }

      // Tenant-controlled Accounting and Finance continuous-close agents.
      try {
        const { runDueContinuousCloseAgents } = await import("./continuous-close.ts");
        await runDueContinuousCloseAgents();
      } catch (e) {
        console.error("[scheduler] continuous-close scan failed:", e);
      }
    });
  } catch (e) {
    // Never let a tick rejection escape setInterval — an unhandled rejection
    // would take down the whole server process on a transient DB error.
    console.error("[scheduler] tick failed:", e);
  } finally {
    running = false;
  }
}
