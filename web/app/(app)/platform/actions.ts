"use server";

import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";
import { db, withBypass } from "@openbooks/engine/platform/db";
import { isUuid } from "../../../lib/list-params";
import { lockSuperAdminActor, requireSuperAdmin } from "../../../lib/super-admin";
import { getTranslations } from "next-intl/server";

function assertUuid(value: string, invalidMessage: string): void {
  if (!isUuid(value)) throw new Error(invalidMessage);
}

/**
 * Every platform mutation resolves — never throws its refusal. Thrown
 * server-action errors surface in production as a generic React Flight
 * digest, so the named refusal (and its remedy) would never reach the
 * operator. Callers toast `message` on `{ ok: false }`.
 */
export type PlatformMutationResult = { ok: true } | { ok: false; message: string };

function refusal(error: unknown, fallback: string): PlatformMutationResult {
  return {
    ok: false,
    message: error instanceof Error && error.message ? error.message : fallback,
  };
}

async function lockPlatformAdminMutations(): Promise<void> {
  await db.execute(sql`
    select pg_advisory_xact_lock(hashtextextended('openbooks:platform-super-admin', 0))
  `);
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

/** Grant or revoke the cross-tenant super-admin flag on a home identity. */
export async function setSuperAdminAction(
  userId: string,
  value: boolean,
): Promise<PlatformMutationResult> {
  try {
    const t = await getTranslations("platform.actions");
    const authz = await requireSuperAdmin();
    assertUuid(userId, t("invalidUser"));
    if (userId === authz.user.homeUserId && !value) {
      throw new Error(t("cannotRevokeOwn"));
    }

    // bypass: cross-org-by-design — platform super-admin status is installation-wide, not an organization's.
    await withBypass(async () => {
      // Serialize every platform-wide super-admin grant/revoke. The active
      // quorum check below reads other administrators' rows, which this
      // transaction does not lock; without one serialization point, two
      // concurrent cross-revocations each count the other's target as still
      // present and jointly strip every platform administrator.
      await lockPlatformAdminMutations();
      await lockSuperAdminActor(db, authz.user.homeUserId);

      const targetResult = await db.execute<{
        id: string;
        orgId: string;
        email: string;
        name: string;
        isSuperAdmin: boolean;
        isActive: boolean;
      }>(
        sql`
        select id, org_id as "orgId", email, name, is_super_admin as "isSuperAdmin", is_active as "isActive"
          from users
         where id = ${userId}
         for update
      `,
        "objects",
      );
      const target = targetResult[0];
      if (!target) throw new Error(t("userNotFound"));
      if (target.isSuperAdmin === value) return;

      if (!value) {
        const countResult = await db.execute<{ count: number }>(
          sql`
          select count(*)::int as count
            from users
           where is_super_admin and is_active
        `,
          "objects",
        );
        if (Number(countResult[0]?.count ?? 0) <= 1) {
          throw new Error(t("finalSuperAdmin"));
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
    return { ok: true };
  } catch (error) {
    return refusal(error, (await getTranslations("platform.actions"))("superAdminFailed"));
  }
}

/**
 * Grant a home identity access to another production organization, acting as
 * an existing active user there. A home-org grant would duplicate implicit
 * access and is rejected.
 */
export async function grantAccessAction(formData: FormData): Promise<PlatformMutationResult> {
  try {
    const t = await getTranslations("platform.actions");
    const authz = await requireSuperAdmin();
    const memberUserId = String(formData.get("memberUserId") ?? "");
    const orgId = String(formData.get("orgId") ?? "");
    const actingUserId = String(formData.get("actingUserId") ?? "");
    assertUuid(memberUserId, t("invalidMember"));
    assertUuid(orgId, t("invalidOrganization"));
    assertUuid(actingUserId, t("invalidActingUser"));

    // bypass: cross-org-by-design — an access grant links a member of one organization to another organization.
    await withBypass(async () => {
      await lockPlatformAdminMutations();
      await lockSuperAdminActor(db, authz.user.homeUserId);
      const validation = await db.execute<{
        memberOrgId: string;
        memberEnvKind: string;
        actingOrgId: string;
        actingActive: boolean;
        targetEnvKind: string;
      }>(
        sql`
        select m.org_id as "memberOrgId", mo.env_kind as "memberEnvKind",
               au.org_id as "actingOrgId", au.is_active as "actingActive",
               target.env_kind as "targetEnvKind"
          from users m
          join orgs mo on mo.id = m.org_id
          join users au on au.id = ${actingUserId}
          join orgs target on target.id = ${orgId}
         where m.id = ${memberUserId}
      `,
        "objects",
      );
      const row = validation[0];
      if (!row) throw new Error(t("grantIdentityNotFound"));
      if (row.memberEnvKind !== "production") throw new Error(t("memberMustBeProduction"));
      if (row.targetEnvKind !== "production") throw new Error(t("targetMustBeProduction"));
      if (row.memberOrgId === orgId) throw new Error(t("homeAccessAlreadyImplicit"));
      if (row.actingOrgId !== orgId) throw new Error(t("actingUserMustBelongToTarget"));
      if (!row.actingActive) throw new Error(t("actingUserMustBeActive"));

      const beforeResult = await db.execute<{
        id: string;
        actingUserId: string;
        isActive: boolean;
      }>(
        sql`
        select id, acting_user_id as "actingUserId", is_active as "isActive"
          from user_org_access
         where member_user_id = ${memberUserId} and org_id = ${orgId}
         for update
      `,
        "objects",
      );
      const before = beforeResult[0] ?? null;

      const result = await db.execute<{ id: string }>(
        sql`
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
        where user_org_access.org_id = ${orgId}
        returning id
      `,
        "objects",
      );
      const accessId = result[0]?.id;
      if (!accessId) throw new Error(t("grantCouldNotSave"));

      await auditPlatformMutation({
        orgId,
        tableName: "user_org_access",
        rowId: accessId,
        action: before ? "update" : "insert",
        actorId: authz.user.homeUserId,
        before: before ? { acting_user_id: before.actingUserId, is_active: before.isActive } : null,
        after: {
          member_user_id: memberUserId,
          org_id: orgId,
          acting_user_id: actingUserId,
          is_active: true,
        },
        reason: before ? "Updated cross-organization access" : "Granted cross-organization access",
      });
    });

    revalidatePath("/platform");
    revalidatePath("/platform/access");
    revalidatePath("/platform/users");
    revalidatePath(`/platform/users/${memberUserId}`);
    return { ok: true };
  } catch (error) {
    return refusal(error, (await getTranslations("platform.actions"))("grantFailed"));
  }
}

/** Soft-revoke an access grant so the control history remains intact. */
export async function revokeAccessAction(accessId: string): Promise<PlatformMutationResult> {
  try {
    const t = await getTranslations("platform.actions");
    const authz = await requireSuperAdmin();
    assertUuid(accessId, t("invalidGrant"));
    let memberUserId: string | null = null;

    // bypass: cross-org-by-design — an access grant links a member of one organization to another organization.
    await withBypass(async () => {
      await lockPlatformAdminMutations();
      await lockSuperAdminActor(db, authz.user.homeUserId);
      const beforeResult = await db.execute<{
        id: string;
        orgId: string;
        memberUserId: string;
        actingUserId: string;
        isActive: boolean;
      }>(
        sql`
        select id, org_id as "orgId", member_user_id as "memberUserId",
               acting_user_id as "actingUserId", is_active as "isActive"
          from user_org_access
         where id = ${accessId}
         for update
      `,
        "objects",
      );
      const before = beforeResult[0];
      if (!before) throw new Error(t("grantNotFound"));
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
    return { ok: true };
  } catch (error) {
    return refusal(error, (await getTranslations("platform.actions"))("revokeFailed"));
  }
}
