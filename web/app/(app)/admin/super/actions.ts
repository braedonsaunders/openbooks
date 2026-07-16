"use server";

import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "@openbooks/engine/src/db.ts";
import { requireSuperAdmin } from "../../../../lib/super-admin";

/** Grant or revoke cross-tenant super-admin on a user's home identity. */
export async function setSuperAdminAction(userId: string, value: boolean): Promise<void> {
  await requireSuperAdmin();
  await withBypassContext(async () => {
    await db.execute(sql`update users set is_super_admin = ${value} where id = ${userId}`);
  });
  revalidatePath("/admin/super");
}

/**
 * Grant a member (login identity) access to another production org, acting as a
 * users row there. Both users must exist; the org must be production.
 */
export async function grantAccessAction(input: {
  memberUserId: string;
  orgId: string;
  actingUserId: string;
}): Promise<void> {
  const authz = await requireSuperAdmin();
  await withBypassContext(async () => {
    // Sanity: acting user must belong to the target org; org must be production.
    const ok = (await db.execute(sql`
      select 1 from users u join orgs o on o.id = u.org_id
       where u.id = ${input.actingUserId} and u.org_id = ${input.orgId} and o.env_kind = 'production'`)) as any;
    if (!ok.rows.length) throw new Error("acting user must belong to the target production org");
    await db.execute(sql`
      insert into user_org_access (member_user_id, org_id, acting_user_id, created_by)
      values (${input.memberUserId}, ${input.orgId}, ${input.actingUserId}, ${authz.user.homeUserId})
      on conflict (member_user_id, org_id)
      do update set acting_user_id = excluded.acting_user_id, is_active = true`);
  });
  revalidatePath("/admin/super");
}

export async function revokeAccessAction(accessId: string): Promise<void> {
  await requireSuperAdmin();
  await withBypassContext(async () => {
    await db.execute(sql`delete from user_org_access where id = ${accessId}`);
  });
  revalidatePath("/admin/super");
}
