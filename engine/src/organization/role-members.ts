import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
export type NativeRoleUser = { id: string; name: string; email: string };
/** Active users explicitly assigned to `role`. */
export async function roleUsers(
  orgId: string,
  role: string,
): Promise<NativeRoleUser[]> {
  if (!role) return [];
  const r = await db.execute<NativeRoleUser>(sql`
    select distinct u.id, u.name, u.email
      from users u
      join role_assignments ra on ra.user_id = u.id and ra.org_id = u.org_id
      join app_roles ar on ar.id = ra.role_id and ar.org_id = ra.org_id and ar.org_id = u.org_id
     where u.org_id = ${orgId} and u.is_active
       and ar.key = ${role}
  `);
  return r.rows;
}
