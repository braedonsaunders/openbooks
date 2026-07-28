import { Worker } from "bullmq";
import { sql } from "drizzle-orm";
import {
  MIGRATION_QUEUE,
  enqueueMigration,
  getBlockingConnection,
  type MigrationJobData,
} from "@openbooks/jobs";
import { db } from "../db.ts";
import { buildSource, getConnection } from "../sync/connection.ts";
import {
  preflightFullSync,
  runFullMigration,
  runSync,
  runTargetedRepair,
} from "../sync/sync.ts";
import { syncProjectFinancialInputs } from "../sync/project-financial-inputs.ts";
import {
  AttachmentImportError,
  importNetSuiteAttachments,
} from "../sync/netsuite-attachments.ts";
import { purgeExpiredQbdBridgeData } from "../qbd/bridge.ts";
import { mirrorIsDue } from "../sync/mirror-schedule.ts";

/**
 * Consumes the `migration` queue: build the tenant's adapter from its stored
 * connection, then run a full migration or an incremental mirror. The sync
 * engine records a sync_runs row (progress + TB and mandatory account-month
 * verification) that the platform page reads; on failure the connection is
 * flagged and BullMQ retries.
 */
export function createMigrationWorker(): Worker<MigrationJobData> {
  return new Worker<MigrationJobData>(
    MIGRATION_QUEUE,
    async (job) => {
      const {
        orgId,
        connectionId,
        mode,
        triggeredBy,
        sourceFileIds,
        sourceRefs,
      } = job.data;
      if (sourceFileIds?.length && mode !== "attachments") {
        throw new Error("sourceFileIds are only valid for attachment jobs");
      }
      if (sourceRefs?.length && mode !== "targeted_repair") {
        throw new Error("sourceRefs are only valid for targeted repair jobs");
      }
      if (mode === "targeted_repair" && !sourceRefs?.length) {
        throw new Error("targeted repair jobs require sourceRefs");
      }
      const conn = await getConnection(orgId, connectionId);
      if (!conn)
        throw new Error(
          `connection ${connectionId} not found for org ${orgId}`,
        );

      if (mode === "attachments") {
        if (conn.source !== "netsuite")
          throw new Error(
            "attachment migration is only supported by NetSuite connections",
          );
        await db.execute(sql`
          update sync_runs
             set status = 'failed', finished_at = now(),
                 error_message = 'Attachment sync was interrupted before the worker could finish it.'
           where org_id = ${orgId} and connection_id = ${connectionId}
             and kind = 'attachments' and status = 'running'
        `);
        const started = (await db.execute(sql`
          insert into sync_runs (org_id, connection_id, source, kind, status, triggered_by, progress)
          values (${orgId}, ${connectionId}, ${conn.source}, 'attachments', 'running', ${triggeredBy ?? "worker"},
                  ${JSON.stringify({ phase: "attachments" })}::jsonb)
          returning id
        `)) as unknown as { rows: { id: string }[] };
        const runId = started.rows[0].id;
        try {
          const summary = await importNetSuiteAttachments({
            org: orgId,
            connectionId,
            execute: true,
            concurrency: 4,
            sourceFileIds,
          });
          await db.execute(sql`
            update sync_runs
               set status = 'ok', finished_at = now(), stats = ${JSON.stringify(summary)}::jsonb,
                   progress = ${JSON.stringify({ phase: "complete" })}::jsonb
             where id = ${runId}
          `);
          return { runId, kind: "attachments", ...summary };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          const stats =
            error instanceof AttachmentImportError ? error.summary : null;
          await db.execute(sql`
            update sync_runs
               set status = 'failed', finished_at = now(), error_message = ${message},
                   stats = ${stats ? JSON.stringify(stats) : null}::jsonb
             where id = ${runId}
          `);
          throw error;
        }
      }

      const source = buildSource(conn);
      if (mode === "project_financials") {
        await db.execute(sql`
          update sync_runs
             set status = 'failed', finished_at = now(),
                 error_message = 'Project-financial sync was interrupted before the worker could finish it.'
           where org_id = ${orgId} and connection_id = ${connectionId}
             and kind = 'project_financials' and status = 'running'
        `);
        const started = (await db.execute(sql`
          insert into sync_runs
            (org_id, connection_id, source, kind, status, triggered_by, progress)
          values
            (${orgId}, ${connectionId}, ${conn.source}, 'project_financials',
             'running', ${triggeredBy ?? "worker"},
             ${JSON.stringify({
               phase: "project_financials",
               message:
                 "Reconciling complete source time-entry billing state…",
             })}::jsonb)
          returning id
        `)) as unknown as { rows: { id: string }[] };
        const runId = started.rows[0]!.id;
        try {
          const summary = await syncProjectFinancialInputs(source, {
            orgId,
            connectionId,
            runId,
            actorId: triggeredBy,
            apply: true,
          });
          await db.execute(sql`
            update sync_runs
               set status = 'ok', finished_at = now(),
                   stats = ${JSON.stringify(summary)}::jsonb,
                   progress = ${JSON.stringify({ phase: "complete" })}::jsonb
             where id = ${runId}
          `);
          return { runId, kind: "project_financials", ...summary };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          await db.execute(sql`
            update sync_runs
               set status = 'failed', finished_at = now(),
                   error_message = ${message}
             where id = ${runId}
          `);
          throw error;
        } finally {
          await source.dispose?.();
        }
      }
      if (mode === "preflight") {
        await db.execute(sql`
          update sync_runs
             set status = 'failed', finished_at = now(),
                 error_message = 'Preflight was interrupted before the worker could finish it.'
           where org_id = ${orgId} and connection_id = ${connectionId}
             and kind = 'full_preflight' and status = 'running'
        `);
        const started = (await db.execute(sql`
          insert into sync_runs
            (org_id, connection_id, source, kind, status, triggered_by, progress)
          values
            (${orgId}, ${connectionId}, ${conn.source}, 'full_preflight',
             'running', ${triggeredBy ?? "worker"},
             ${JSON.stringify({
               phase: "preflight",
               message: "Comparing the complete source and target populations…",
             })}::jsonb)
          returning id
        `)) as unknown as { rows: { id: string }[] };
        const runId = started.rows[0]!.id;
        try {
          const plan = await preflightFullSync(source, {
            orgId,
            connectionId,
          });
          await db.execute(sql`
            update sync_runs
               set status = 'ok', finished_at = now(),
                   stats = ${JSON.stringify(plan)}::jsonb,
                   progress = ${JSON.stringify({ phase: "complete" })}::jsonb
             where id = ${runId}
          `);
          return { runId, kind: "full_preflight", ...plan };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          await db.execute(sql`
            update sync_runs
               set status = 'failed', finished_at = now(),
                   error_message = ${message}
             where id = ${runId}
          `);
          throw error;
        } finally {
          await source.dispose?.();
        }
      }
      const ctx = { orgId, connectionId };
      const result =
        mode === "full_migration"
          ? await runFullMigration(source, triggeredBy ?? "worker", ctx)
          : mode === "targeted_repair"
            ? await runTargetedRepair(
                source,
                sourceRefs!,
                triggeredBy ?? "worker",
                ctx,
              )
          : await runSync(source, triggeredBy ?? "worker", ctx);

      return {
        runId: result.runId,
        kind: result.kind,
        docsNew: result.docsNew,
        docsAmended: result.docsAmended,
        tb: {
          accounts: result.tb.accounts,
          matches: result.tb.matches,
          mismatches: result.tb.mismatches.length,
        },
        periods: {
          checked: result.periods.checked,
          matches: result.periods.matches,
          mismatches: result.periods.checked - result.periods.matches,
        },
        projectPeriods: result.projectPeriods
          ? {
              checked: result.projectPeriods.checked,
              matches: result.projectPeriods.matches,
              mismatches:
                result.projectPeriods.checked - result.projectPeriods.matches,
            }
          : null,
        openItems: result.openItems
          ? {
              checked: result.openItems.checked,
              matches: result.openItems.matches,
            }
          : null,
      };
    },
    {
      connection: getBlockingConnection(),
      concurrency: 2,
      // A compose rollout can terminate a worker before its long-running,
      // idempotent migration has drained. Let the replacement worker resume
      // instead of permanently failing after BullMQ's single-stall default.
      lockDuration: 5 * 60_000,
      maxStalledCount: 6,
      stalledInterval: 30_000,
    },
  );
}

const MIRROR_TICK_MS = 5 * 60_000;

/**
 * Stale-run reaper. A worker that dies mid-run (deploy rollout, crash, OOM)
 * leaves its sync_runs row 'running' forever — and the mirror scheduler's
 * concurrency guard below then refuses to enqueue the next mirror for that
 * connection, a permanent stall that merely LOOKS like a live run. Sweep rows
 * that can no longer have a live owner: well past BullMQ's lock + stalled
 * recovery window (5 min lockDuration, 30 s stalledInterval) for incremental
 * and attachment runs, hours for full migrations. A rare false positive is
 * self-correcting: the still-running attempt writes its final status by id
 * when it finishes, overwriting the reaper's mark.
 */
export async function reapStaleSyncRuns(): Promise<number> {
  const res = (await db.execute(sql`
    update sync_runs
       set status = 'failed', finished_at = now(),
           error_message = 'Run never finished: the worker was interrupted (deploy, crash, or restart). Marked failed by the stale-run reaper.'
     where status = 'running'
       and started_at < now() - case
         when kind = 'full_migration' then interval '6 hours'
         else interval '30 minutes'
       end`)) as unknown as { rowCount?: number };
  return res.rowCount ?? 0;
}

/**
 * Mirror scheduler: cadence is based only on the last successful incremental
 * proof. Failed mirrors retry with bounded exponential backoff; attachment and
 * full-migration activity never postpones or disables the mirror.
 */
export function startMirrorScheduler(): void {
  const tick = async () => {
    try {
      const reaped = await reapStaleSyncRuns();
      if (reaped > 0)
        console.log(`[mirror-scheduler] reaped ${reaped} stale sync run(s)`);
      await purgeExpiredQbdBridgeData();
      const candidates = (await db.execute(sql`
        select c.id, c.org_id as "orgId", c.mirror_schedule as schedule,
               history.last_successful_at as "lastSuccessfulAt",
               history.last_scheduled_attempt_at as "lastScheduledAttemptAt",
               history.scheduled_failures_since_success::int as "scheduledFailuresSinceSuccess"
          from connections c
          cross join lateral (
            select
              max(sr.finished_at) filter (
                where sr.kind = 'incremental' and sr.status = 'ok'
              ) as last_successful_at,
              max(sr.started_at) filter (
                where sr.kind = 'incremental' and sr.triggered_by = 'scheduler'
              ) as last_scheduled_attempt_at,
              count(*) filter (
                where sr.kind = 'incremental' and sr.triggered_by = 'scheduler'
                  and sr.status = 'failed'
                  and sr.started_at > coalesce((
                    select max(ok.finished_at) from sync_runs ok
                     where ok.connection_id = c.id and ok.kind = 'incremental' and ok.status = 'ok'
                  ), '-infinity'::timestamptz)
              ) as scheduled_failures_since_success
            from sync_runs sr where sr.connection_id = c.id
          ) history
         where c.mirror_enabled and c.status not in ('paused', 'unconfigured')
           and not exists (
             select 1 from sync_runs running
              where running.connection_id = c.id and running.kind = 'incremental' and running.status = 'running'
           )`)) as unknown as {
        rows: {
          id: string;
          orgId: string;
          schedule: string;
          lastSuccessfulAt: Date | null;
          lastScheduledAttemptAt: Date | null;
          scheduledFailuresSinceSuccess: number;
        }[];
      };
      const now = new Date();
      for (const c of candidates.rows) {
        if (!mirrorIsDue({ ...c, now })) continue;
        const bucket = Math.floor(now.getTime() / MIRROR_TICK_MS);
        await enqueueMigration(
          {
            orgId: c.orgId,
            connectionId: c.id,
            mode: "mirror",
            triggeredBy: "scheduler",
          },
          { jobId: `mirror|${c.id}|${bucket}` },
        );
      }
    } catch (e) {
      console.error("[mirror-scheduler]", (e as Error).message);
    }
  };
  void tick();
  setInterval(() => void tick(), MIRROR_TICK_MS);
}
