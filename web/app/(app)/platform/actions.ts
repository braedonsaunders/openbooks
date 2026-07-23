"use server";

import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";
import { db, withBypass } from "@openbooks/engine/src/db.ts";
import { isUuid } from "../../../lib/list-params";
import { requireSuperAdmin } from "../../../lib/super-admin";
import { enterOrg } from "../../../lib/sandbox-session";

function assertUuid(value: string, label: string): void {
  if (!isUuid(value)) throw new Error(`${label} is invalid`);
}

async function auditPlatformMutation(input: {
  orgId: string;
  tableName: "users" | "user_org_access";
  rowId: string;
  action: "insert" | "update";
  actorId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  reason: string;
}): Promise<void> {
  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (
      ${input.orgId},
      ${input.tableName},
      ${input.rowId},
      ${input.action},
      ${JSON.stringify({
        source: "platform_admin",
        reason: input.reason,
        before: input.before,
        after: input.after,
      })}::jsonb,
      ${input.actorId}
    )
  `);
}

/** Enter an organization from the platform list after the shared access resolver validates it. */
export async function enterOrganizationAction(
  formData: FormData,
): Promise<void> {
  await requireSuperAdmin();
  const orgId = String(formData.get("orgId") ?? "");
  assertUuid(orgId, "Organization");
  await enterOrg(orgId);
}

/** Grant or revoke the cross-tenant super-admin flag on a home identity. */
export async function setSuperAdminAction(
  userId: string,
  value: boolean,
): Promise<void> {
  const authz = await requireSuperAdmin();
  assertUuid(userId, "User");
  if (userId === authz.user.homeUserId && !value) {
    throw new Error("You cannot revoke your own super-admin access");
  }

  await withBypass(async () => {
    const targetResult = (await db.execute(sql`
      select id, org_id as "orgId", email, name, is_super_admin as "isSuperAdmin", is_active as "isActive"
        from users
       where id = ${userId}
       for update
    `)) as {
      rows: {
        id: string;
        orgId: string;
        email: string;
        name: string;
        isSuperAdmin: boolean;
        isActive: boolean;
      }[];
    };
    const target = targetResult.rows[0];
    if (!target) throw new Error("User not found");
    if (target.isSuperAdmin === value) return;

    if (!value) {
      const countResult = (await db.execute(sql`
        select count(*)::int as count
          from users
         where is_super_admin and is_active
      `)) as { rows: { count: number }[] };
      if (Number(countResult.rows[0]?.count ?? 0) <= 1) {
        throw new Error(
          "The final active super administrator cannot be revoked",
        );
      }
    }

    await db.execute(sql`
      update users
         set is_super_admin = ${value}, updated_at = now(), updated_by = ${authz.user.homeUserId}
       where id = ${userId}
    `);
    await auditPlatformMutation({
      orgId: target.orgId,
      tableName: "users",
      rowId: userId,
      action: "update",
      actorId: authz.user.homeUserId,
      before: { is_super_admin: target.isSuperAdmin },
      after: { is_super_admin: value },
      reason: value
        ? "Granted platform super-admin access"
        : "Revoked platform super-admin access",
    });
  });

  revalidatePath("/platform");
  revalidatePath("/platform/users");
  revalidatePath(`/platform/users/${userId}`);
}

/**
 * Grant a home identity access to another production organization, acting as
 * an existing active user there. A home-org grant would duplicate implicit
 * access and is rejected.
 */
export async function grantAccessAction(formData: FormData): Promise<void> {
  const authz = await requireSuperAdmin();
  const memberUserId = String(formData.get("memberUserId") ?? "");
  const orgId = String(formData.get("orgId") ?? "");
  const actingUserId = String(formData.get("actingUserId") ?? "");
  assertUuid(memberUserId, "Member");
  assertUuid(orgId, "Organization");
  assertUuid(actingUserId, "Acting user");

  await withBypass(async () => {
    const validation = (await db.execute(sql`
      select m.org_id as "memberOrgId", mo.env_kind as "memberEnvKind",
             au.org_id as "actingOrgId", au.is_active as "actingActive",
             target.env_kind as "targetEnvKind"
        from users m
        join orgs mo on mo.id = m.org_id
        join users au on au.id = ${actingUserId}
        join orgs target on target.id = ${orgId}
       where m.id = ${memberUserId}
    `)) as {
      rows: {
        memberOrgId: string;
        memberEnvKind: string;
        actingOrgId: string;
        actingActive: boolean;
        targetEnvKind: string;
      }[];
    };
    const row = validation.rows[0];
    if (!row)
      throw new Error("Member, organization, or acting user was not found");
    if (row.memberEnvKind !== "production")
      throw new Error(
        "The member identity must belong to a production organization",
      );
    if (row.targetEnvKind !== "production")
      throw new Error(
        "Explicit access can only target a production organization",
      );
    if (row.memberOrgId === orgId)
      throw new Error(
        "A user already has implicit access to their home organization",
      );
    if (row.actingOrgId !== orgId)
      throw new Error("The acting user must belong to the target organization");
    if (!row.actingActive) throw new Error("The acting user must be active");

    const beforeResult = (await db.execute(sql`
      select id, acting_user_id as "actingUserId", is_active as "isActive"
        from user_org_access
       where member_user_id = ${memberUserId} and org_id = ${orgId}
       for update
    `)) as { rows: { id: string; actingUserId: string; isActive: boolean }[] };
    const before = beforeResult.rows[0] ?? null;

    const result = (await db.execute(sql`
      insert into user_org_access (
        member_user_id, org_id, acting_user_id, is_active, created_by, updated_by
      )
      values (${memberUserId}, ${orgId}, ${actingUserId}, true, ${authz.user.homeUserId}, ${authz.user.homeUserId})
      on conflict (member_user_id, org_id)
      do update set
        acting_user_id = excluded.acting_user_id,
        is_active = true,
        updated_at = now(),
        updated_by = excluded.updated_by
      returning id
    `)) as { rows: { id: string }[] };
    const accessId = result.rows[0]?.id;
    if (!accessId) throw new Error("Access grant could not be saved");

    await auditPlatformMutation({
      orgId,
      tableName: "user_org_access",
      rowId: accessId,
      action: before ? "update" : "insert",
      actorId: authz.user.homeUserId,
      before: before
        ? { acting_user_id: before.actingUserId, is_active: before.isActive }
        : null,
      after: {
        member_user_id: memberUserId,
        org_id: orgId,
        acting_user_id: actingUserId,
        is_active: true,
      },
      reason: before
        ? "Updated cross-organization access"
        : "Granted cross-organization access",
    });
  });

  revalidatePath("/platform");
  revalidatePath("/platform/access");
  revalidatePath("/platform/users");
  revalidatePath(`/platform/users/${memberUserId}`);
}

/** Soft-revoke an access grant so the control history remains intact. */
export async function revokeAccessAction(accessId: string): Promise<void> {
  const authz = await requireSuperAdmin();
  assertUuid(accessId, "Access grant");
  let memberUserId: string | null = null;

  await withBypass(async () => {
    const beforeResult = (await db.execute(sql`
      select id, org_id as "orgId", member_user_id as "memberUserId",
             acting_user_id as "actingUserId", is_active as "isActive"
        from user_org_access
       where id = ${accessId}
       for update
    `)) as {
      rows: {
        id: string;
        orgId: string;
        memberUserId: string;
        actingUserId: string;
        isActive: boolean;
      }[];
    };
    const before = beforeResult.rows[0];
    if (!before) throw new Error("Access grant not found");
    memberUserId = before.memberUserId;
    if (!before.isActive) return;

    await db.execute(sql`
      update user_org_access
         set is_active = false, updated_at = now(), updated_by = ${authz.user.homeUserId}
       where id = ${accessId}
    `);
    await auditPlatformMutation({
      orgId: before.orgId,
      tableName: "user_org_access",
      rowId: accessId,
      action: "update",
      actorId: authz.user.homeUserId,
      before: { acting_user_id: before.actingUserId, is_active: true },
      after: { acting_user_id: before.actingUserId, is_active: false },
      reason: "Revoked cross-organization access",
    });
  });

  revalidatePath("/platform");
  revalidatePath("/platform/access");
  revalidatePath("/platform/users");
  if (memberUserId) revalidatePath(`/platform/users/${memberUserId}`);
}
