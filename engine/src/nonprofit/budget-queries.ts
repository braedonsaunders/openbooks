import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";

export async function activeBudgetRootSubsidiaryId(orgId: string): Promise<string | null> {
  const rows = await db.execute<{ id: string }>(
    sql`
    select id from subsidiaries
     where org_id = ${orgId}
       and parent_id is null and is_active and not is_elimination
     order by created_at, id
     limit 1
  `,
    "objects",
  );
  return rows[0]?.id ?? null;
}
