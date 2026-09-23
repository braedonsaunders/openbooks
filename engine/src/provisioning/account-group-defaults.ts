import { sql } from "drizzle-orm";
import { DEFAULT_ACCOUNT_GROUPS } from "@openbooks/schema";
import { db } from "../platform/db.ts";

type SqlExecutor = Pick<typeof db, "execute">;

/**
 * Insert the product-owned default `cost_pool` and `burden` account groups
 * for one org. INSERT-MISSING ONLY: keyed on (org_id, dimension, key), an
 * existing row is left exactly as the tenant left it — a customized match
 * rule is never reverted and a deactivated group is never reactivated.
 * Tenant edits win; only genuinely absent defaults are added.
 *
 * The `on conflict do nothing` below is that guarantee, not a convenience:
 * the previous standalone seeder refreshed every default in place, so
 * re-running it silently erased operator classification policy with no
 * audit. A genuine "reset to defaults" stays an explicit per-group admin
 * edit through the account-group API (which audits before/after), never a
 * side effect of provisioning.
 */
export async function ensureAccountGroupDefaults(
  orgId: string,
  actorId: string | null = null,
  executor: SqlExecutor = db,
): Promise<void> {
  for (const group of DEFAULT_ACCOUNT_GROUPS) {
    await executor.execute(sql`
      insert into account_groups (
        org_id, dimension, key, name, color, sort_order, match, is_catch_all,
        created_by, updated_by
      )
      values (
        ${orgId}, ${group.dimension}, ${group.key}, ${group.name}, ${group.color},
        ${group.sortOrder}, ${JSON.stringify(group.match)}::jsonb, ${group.isCatchAll},
        ${actorId}, ${actorId}
      )
      on conflict (org_id, dimension, key) do nothing
    `);
  }
}
