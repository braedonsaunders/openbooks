import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";

export async function readPublishedCloseBinder(
  orgId: string,
  runId: string,
): Promise<{ binder_snapshot: unknown; binder_hash: string | null } | null> {
  return withOrgTransaction(orgId, async () => {
    const rows = await db.execute<{
      binder_snapshot: unknown;
      binder_hash: string | null;
    }>(
      sql`
      select binder_snapshot, binder_hash
        from close_runs
       where id = ${runId} and org_id = ${orgId} and status = 'published'
    `,
      "objects",
    );
    return rows[0] ?? null;
  });
}
