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
      const upserted = await tx.execute<{ id: string }>(sql`
        insert into app_roles (org_id, key, name, description, is_built_in, permissions)
        values (${orgId}, ${key}, ${def.name}, ${def.description}, true, ${JSON.stringify(def.permissions)})
        on conflict (org_id, key) do update
          set name = excluded.name,
              description = excluded.description,
              updated_at = now()
        where app_roles.is_built_in
        returning id
      `);
      if (upserted.rows.length !== 1) {
        throw new Error(
          `built-in role "${key}" for organization ${orgId} was not seeded: ` +
            `a custom role already uses that key. Rename the custom role in ` +
            `Admin -> Users & Roles, then re-run the seed.`,
        );
      }
    }
  });
}
