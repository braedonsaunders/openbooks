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
import { runFullMigration, runSync } from "../sync/sync.ts";
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
      const { orgId, connectionId, mode, triggeredBy } = job.data;
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
      const ctx = { orgId, connectionId };
      const result =
        mode === "full_migration"
          ? await runFullMigration(source, triggeredBy ?? "worker", ctx)
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
 * Mirror scheduler: cadence is based only on the last successful incremental
 * proof. Failed mirrors retry with bounded exponential backoff; attachment and
 * full-migration activity never postpones or disables the mirror.
 */
export function startMirrorScheduler(): void {
  const tick = async () => {
    try {
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
