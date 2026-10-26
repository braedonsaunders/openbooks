import { sql } from "drizzle-orm";
import type { BUILT_IN_ROLES } from "../organization/permissions.ts";
import type { db, SqlExecutor } from "../platform/db.ts";

/**
 * A handle the catalogue seed can open its one atomic unit on: the pooled
 * `db` in every caller. Transaction-capable, so the whole catalogue either
 * lands together or rolls back together.
 */
export type BuiltInRoleSeedRunner = SqlExecutor & Pick<typeof db, "transaction">;

/**
 * One shared upsert for the built-in tenant roles, used by both seed entry
 * points (the roles seeder and the bootstrap role step).
 *
 * New-organization defaults only. The first insert stores the current
 * catalogue permissions; a re-run refreshes only the built-in display
 * metadata (name, description) and never reads or writes the stored
 * permissions, so grants an administrator customized or reduced survive
 * re-seeding exactly as configured. A future catalogue addition therefore
 * reaches new organizations automatically while existing tenants keep their
 * configured grants until an administrator changes them explicitly.
 *
 * The whole catalogue seeds inside one transaction: when a same-key custom
 * role blocks its key, the exactly-one-row refusal below rolls back the
 * earlier inserts and metadata refreshes too, so a partial catalogue can
 * never commit. A same-key row that is not built-in is never converted or
 * overwritten. Every key must affect exactly one row; any other count is a
 * dropped write and fails loudly.
 */
export async function upsertBuiltInRolesForOrg(
  runner: BuiltInRoleSeedRunner,
  orgId: string,
  roles: typeof BUILT_IN_ROLES,
): Promise<void> {
  await runner.transaction(async (tx) => {
    for (const [key, def] of Object.entries(roles)) {
      const upserted = await tx.execute<{ id: string }>(
        sql`
        insert into app_roles (org_id, key, name, description, is_built_in, permissions)
        values (${orgId}, ${key}, ${def.name}, ${def.description}, true, ${JSON.stringify(def.permissions)})
        on conflict (org_id, key) do update
          set name = excluded.name,
              description = excluded.description,
              updated_at = now()
        where app_roles.is_built_in
        returning id
      `,
        "objects",
      );
      if (upserted.length !== 1) {
        throw new Error(
          `built-in role "${key}" for organization ${orgId} was not seeded: ` +
            `a custom role already uses that key. In Admin -> Users & Roles, ` +
            `create a replacement custom role with a different key and the same permissions and subsidiary scope, ` +
            `reassign every affected user to it, then delete the conflicting custom role and re-run the seed.`,
        );
      }
    }
  });
}

export type AdministratorRoleAlignment = "aligned" | "unchanged" | "absent";

/**
 * Keep an organization's built-in Administrator role holding the full
 * permission catalogue.
 *
 * Admin -> Roles refuses every edit to that role, so its stored grants can
 * never carry an administrator's customization; they are only ever the
 * catalogue as of the release that seeded the organization. Without this
 * step, permissions introduced by later releases would never reach existing
 * organizations' administrators, and nobody could grant them.
 *
 * Alignment is additive: missing catalogue permissions are appended and
 * nothing already stored is removed, so grants contributed outside the
 * catalogue survive. A same-key custom role is never touched. A change is
 * recorded in audit_log with before/after grants in the same transaction.
 */
export async function alignBuiltInAdministratorRole(
  runner: BuiltInRoleSeedRunner,
  orgId: string,
  catalogue: readonly string[],
): Promise<AdministratorRoleAlignment> {
  return runner.transaction(async (tx) => {
    const rows = await tx.execute<{ id: string; permissions: unknown }>(
      sql`
      select id, permissions from app_roles
       where org_id = ${orgId} and key = 'admin' and is_built_in
       for update
    `,
      "objects",
    );
    const role = rows[0];
    if (!role) return "absent";
    const stored = Array.isArray(role.permissions)
      ? role.permissions.filter((key): key is string => typeof key === "string")
      : [];
    const held = new Set(stored);
    const missing = catalogue.filter((key) => !held.has(key));
    if (missing.length === 0) return "unchanged";
    const next = [...stored, ...missing];
    const updated = await tx.execute<{ id: string }>(
      sql`
      update app_roles set permissions = ${JSON.stringify(next)}::jsonb, updated_at = now()
       where id = ${role.id} and org_id = ${orgId}
      returning id
    `,
      "objects",
    );
    if (updated.length !== 1) {
      throw new Error(
        `built-in Administrator role for organization ${orgId} was not aligned to the permission catalogue`,
      );
    }
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'app_roles', ${role.id}, 'update',
              ${JSON.stringify({ permissions: [stored, next], added: missing, reason: "built_in_administrator_catalogue_alignment" })}::jsonb,
              null)
    `);
    return "aligned";
  });
}
