import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";

export async function createQueuedBackupRun(orgId: string, actorId: string): Promise<string> {
  const result = await db.execute<{ id: string }>(sql`
    insert into backup_runs (org_id, kind, status, actor_id)
    values (${orgId}, 'manual', 'queued', ${actorId})
    returning id`);
  return result.rows[0]!.id;
}

export async function markBackupEnqueueFailed(
  orgId: string,
  runId: string,
  actorId: string,
  message: string,
): Promise<"accepted" | "failed"> {
  return withOrgTransaction(orgId, async () => {
    const transitioned = await db.execute<{ id: string }>(
      sql`
      update backup_runs
         set status = 'failed', error = ${message}, completed_at = now(), updated_at = now()
       where id = ${runId} and org_id = ${orgId} and status = 'queued'
      returning id`,
      "objects",
    );
    if (transitioned.length !== 1) {
      const current = await db.execute<{ status: string }>(
        sql`
        select status from backup_runs where id = ${runId} and org_id = ${orgId}`,
        "objects",
      );
      if (current[0] && current[0].status !== "queued") return "accepted";
      throw new Error(`backup run ${runId} was not queued when enqueue failure cleanup ran`);
    }
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'backup_runs', ${runId}, 'update',
              jsonb_build_object('event', 'backup_enqueue_failed', 'status', jsonb_build_object('before', 'queued', 'after', 'failed'), 'error', ${message}),
              ${actorId})`);
    return "failed";
  });
}
