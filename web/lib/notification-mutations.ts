import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";

/** Mark notifications read only within the authenticated user's organization and inbox. */
export async function markNotificationsReadForRoute(input: {
  orgId: string;
  userId: string;
  ids?: string[];
  all?: boolean;
}) {
  if (input.all) {
    const rows = await db.execute<{ id: string }>(
      sql`
      update notifications
         set read_at = now(), updated_at = now()
       where org_id = ${input.orgId} and user_id = ${input.userId} and read_at is null
      returning id
    `,
      "objects",
    );
    return { own: rows.length };
  }
  const ids = [...new Set(input.ids ?? [])];
  if (ids.length === 0) return { own: 0 };
  const owned = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from notifications
         where org_id = ${input.orgId} and user_id = ${input.userId} and id = any(${ids})`,
    "objects",
  );
  const count = Number(owned[0]?.n ?? 0);
  if (count < ids.length) return { own: count };
  await db.execute(
    sql`update notifications set read_at = now(), updated_at = now()
         where org_id = ${input.orgId} and user_id = ${input.userId}
           and id = any(${ids})
           and read_at is null returning id`,
    "objects",
  );
  return { own: count };
}
