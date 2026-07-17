import { sql } from "drizzle-orm";
import {
  DASHBOARD_ROLE_KEYS,
  defaultDashboardLayoutForRole,
} from "@openbooks/schema";
import { db } from "./db.ts";

/**
 * Persist the product defaults for a tenant. Existing user customisations are
 * intentionally untouched; role defaults are refreshed so reset-to-default
 * and users who have not customised immediately receive the current design.
 */
export async function seedDashboardDefaultsForOrg(
  orgId: string,
  roleKeys: readonly string[] = DASHBOARD_ROLE_KEYS,
): Promise<number> {
  const keys = [...new Set(roleKeys)];

  await db.transaction(async (tx) => {
    for (const roleKey of keys) {
      const layout = defaultDashboardLayoutForRole(roleKey);
      await tx.execute(sql`
        insert into role_dashboard_layouts (org_id, role_key, layout)
        values (${orgId}, ${roleKey}, ${JSON.stringify(layout)}::jsonb)
        on conflict (org_id, role_key) do update
          set layout = excluded.layout, updated_at = now()
      `);
    }
  });

  return keys.length;
}
