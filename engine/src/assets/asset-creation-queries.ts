import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";

export async function hasActiveAssetCategory(orgId: string, categoryId: string): Promise<boolean> {
  const rows = await db.execute<{ id: string }>(
    sql`
    select id from asset_categories
     where org_id = ${orgId} and is_active and id = ${categoryId}
  `,
    "objects",
  );
  return rows.some((row) => String(row.id).toLowerCase() === categoryId);
}

export async function listAvailableAssetSubsidiaries(input: {
  orgId: string;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}): Promise<{ id: string }[]> {
  return db.execute<{ id: string }>(
    sql`
    select id from subsidiaries
     where org_id = ${input.orgId} and is_active and not is_elimination
       ${input.allowedSubsidiaryIds ? sql`and id = any(${`{${[...input.allowedSubsidiaryIds].join(",")}}`}::uuid[])` : sql``}
     order by (parent_id is null) desc, name
  `,
    "objects",
  );
}
