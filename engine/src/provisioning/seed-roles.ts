import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { BUILT_IN_ROLES } from "../organization/permissions.ts";
import { upsertBuiltInRolesForOrg } from "./built-in-role-seed.ts";
import { seedDashboardDefaultsForOrg } from "./dashboard-defaults.ts";

/**
 * Seed the RBAC foundation:
 *   npx tsx engine/src/provisioning/seed-roles.ts
 *
 * For every org: ensure the built-in roles exist in app_roles.
 *
 * New-org defaults only — a re-run refreshes built-in name/description
 * metadata and leaves stored permissions exactly as configured, so
 * customized or reduced grants survive re-seeding. Existing assignments are
 * left untouched, and custom roles are never modified.
 */

export type SeedRolesForOrgResult = {
  roles: number;
  dashboardDefaults: number;
};

/** Thin per-org entry: built-in roles plus dashboard defaults for one org. */
export async function seedRolesForOrg(orgId: string): Promise<SeedRolesForOrgResult> {
  await upsertBuiltInRolesForOrg(db, orgId, BUILT_IN_ROLES);
  const dashboardDefaults = await seedDashboardDefaultsForOrg(
    orgId,
    Object.keys(BUILT_IN_ROLES),
  );
  return { roles: Object.keys(BUILT_IN_ROLES).length, dashboardDefaults };
}

async function main(): Promise<void> {
  const orgs = (await db.execute<{ id: string; name: string }>(sql`select id, name from orgs order by created_at`));
  if (orgs.rows.length === 0) {
    console.error("no orgs found — seed an org before seeding roles");
    process.exit(1);
  }

  for (const org of orgs.rows) {
    const done = await seedRolesForOrg(org.id);
    console.log(
      `org "${org.name}": ${done.roles} built-in roles ensured ` +
        `(new-org defaults; existing grants unchanged), ` +
        `${done.dashboardDefaults} dashboard default(s) upserted`,
    );
  }
}

/**
 * Run directly (`tsx seed-roles.ts`) but never merely because this module
 * was imported — the integration test drives the exported per-org entry.
 */
export function isSeedRolesCli(entrypoint: string | undefined): boolean {
  return /(^|[/\\])seed-roles\.(?:[cm]?[jt]s)$/.test(entrypoint ?? "");
}

if (isSeedRolesCli(process.argv[1])) {
  void main().then(() => process.exit(0)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
