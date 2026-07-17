import { Worker } from "bullmq";
import { sql } from "drizzle-orm";
import { MIGRATION_QUEUE, enqueueMigration, getBlockingConnection, type MigrationJobData } from "@openbooks/jobs";
import { db } from "../db.ts";
import { buildSource, getConnection } from "../sync/connection.ts";
import { runFullMigration, runSync } from "../sync/sync.ts";

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
    { connection: getBlockingConnection(), concurrency: 2 },
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
