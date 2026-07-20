import { Worker } from "bullmq";
import { sql } from "drizzle-orm";
import { MIGRATION_QUEUE, enqueueMigration, getBlockingConnection, type MigrationJobData } from "@openbooks/jobs";
import { db } from "../db.ts";
import { buildSource, getConnection } from "../sync/connection.ts";
import { runFullMigration, runSync } from "../sync/sync.ts";
import { AttachmentImportError, importNetSuiteAttachments } from "../sync/netsuite-attachments.ts";
import { purgeExpiredQbdBridgeData } from "../qbd/bridge.ts";

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
      if (!conn) throw new Error(`connection ${connectionId} not found for org ${orgId}`);

      if (mode === "attachments") {
        if (conn.source !== "netsuite") throw new Error("attachment migration is only supported by NetSuite connections");
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
          await db.execute(sql`
            update connections set status = 'active', last_error = null, last_run_at = now() where id = ${connectionId}
          `);
          return { runId, kind: "attachments", ...summary };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const stats = error instanceof AttachmentImportError ? error.summary : null;
          await db.execute(sql`
            update sync_runs
               set status = 'failed', finished_at = now(), error_message = ${message},
                   stats = ${stats ? JSON.stringify(stats) : null}::jsonb
             where id = ${runId}
          `);
          await db.execute(sql`
            update connections set status = 'error', last_error = ${message}, last_run_at = now() where id = ${connectionId}
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
        tb: { accounts: result.tb.accounts, matches: result.tb.matches, mismatches: result.tb.mismatches.length },
        periods: {
          checked: result.periods.checked,
          matches: result.periods.matches,
          mismatches: result.periods.checked - result.periods.matches,
        },
        openItems: result.openItems
          ? { checked: result.openItems.checked, matches: result.openItems.matches }
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

/**
 * Mirror scheduler: every 5 minutes, enqueue a mirror pass for each connection
 * with mirroring enabled whose last run is older than its cadence (daily).
 * The per-day jobId dedupes — a tick can never double-queue the same day.
 */
export function startMirrorScheduler(): void {
  const tick = async () => {
    try {
      await purgeExpiredQbdBridgeData();
      const due = (await db.execute(sql`
        select id, org_id as "orgId" from connections
         where mirror_enabled and status = 'active'
           and (last_run_at is null or last_run_at < now() - interval '1 day')`)) as unknown as {
        rows: { id: string; orgId: string }[];
      };
      for (const c of due.rows) {
        const day = new Date().toISOString().slice(0, 10);
        await enqueueMigration(
          { orgId: c.orgId, connectionId: c.id, mode: "mirror", triggeredBy: "scheduler" },
          { jobId: `mirror|${c.id}|${day}` },
        );
      }
    } catch (e) {
      console.error("[mirror-scheduler]", (e as Error).message);
    }
  };
  void tick();
  setInterval(() => void tick(), 5 * 60_000);
}
