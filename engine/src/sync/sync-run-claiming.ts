import { sql } from "drizzle-orm";
import { db, schema } from "../platform/db.ts";
import { type SyncProgress } from "./native.ts";
import { SyncRunAlreadyActiveError, syncConnectionRunLockKey } from "./sync-run-locks.ts";

/** Best-effort live progress write (throttled) so the platform page can show a
 *  real "pulling/posting X of Y" bar. Never fails a sync — progress is cosmetic. */
const _progressAt = new Map<string, number>();
export async function setProgress(
  orgId: string,
  runId: string,
  p: SyncProgress,
  force = false,
): Promise<void> {
  const now = Date.now();
  if (!force && now - (_progressAt.get(runId) ?? 0) < 700) return;
  _progressAt.set(runId, now);
  try {
    await db.execute(
      sql`update sync_runs set progress = ${JSON.stringify(p)}::jsonb where id = ${runId} and org_id = ${orgId}`,
    );
  } catch {
    /* progress is best-effort */
  }
}

/** Takes exclusive ownership of a connection for one mutating run. */
export async function claimSyncRun(opts: {
  orgId: string;
  connectionId: string;
  kind: "incremental" | "full_migration" | "targeted_repair" | "project_financials" | "attachments";
  sourceName: string;
  triggeredBy: string;
}): Promise<[{ id: string }]> {
  // The insert below has no conflict clause, so success always yields exactly
  // one row; the tuple type carries that invariant to the three claim sites.
  const [row] = await db.transaction(async (tx) => {
    // QuickBooks Desktop captures are connection-scoped, not run-kind-scoped:
    // a mirror and a full migration would otherwise supersede each other's
    // live Web Connector capture in prepareCapture.
    const qbd = opts.sourceName === "qbd";
    await tx.execute(sql`
      select pg_advisory_xact_lock(
        hashtext(${opts.orgId}),
        hashtext(${qbd ? `sync-run:${opts.connectionId}:qbd` : syncConnectionRunLockKey(opts.connectionId)})
      )`);
    const live = await tx.execute(
      sql`
      select 1 from sync_runs
       where org_id = ${opts.orgId} and connection_id = ${opts.connectionId}
         and (${qbd} or kind = ${opts.kind}
              or kind in ('incremental', 'full_migration', 'targeted_repair', 'project_financials', 'attachments'))
         and status = 'running'
       limit 1`,
      "objects",
    );
    if (live.length > 0) throw new SyncRunAlreadyActiveError(opts.kind);
    return tx
      .insert(schema.syncRuns)
      .values({
        orgId: opts.orgId,
        connectionId: opts.connectionId,
        source: opts.sourceName,
        kind: opts.kind,
        triggeredBy: opts.triggeredBy,
      })
      .returning();
  });
  // Fail closed: hand no caller an undefined claim.
  if (!row) throw new Error("sync run claim inserted no row");
  return [row];
}
