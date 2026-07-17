import { requirePermission } from "../../../../../lib/authz";
import { ensureCrmDefaults } from "@openbooks/engine/src/crm.ts";
import { db } from "@openbooks/engine/src/db.ts";
import { sql } from "drizzle-orm";
import { CrmSetupWorkspace } from "./CrmSetupWorkspace";

export const dynamic = "force-dynamic";

export default async function CrmSetup() {
  const authz = await requirePermission("crm.setup.manage");
  await ensureCrmDefaults(authz.user.orgId, authz.user.id);
  const [
    accountStatuses,
    opportunityStatuses,
    territories,
    sources,
    teams,
    quotas,
    users,
  ] = await Promise.all([
    db.execute(
      sql`select * from crm_account_statuses where org_id=${authz.user.orgId} order by lifecycle_stage,sequence`,
    ) as any,
    db.execute(
      sql`select * from crm_opportunity_statuses where org_id=${authz.user.orgId} order by sequence`,
    ) as any,
    db.execute(
      sql`select t.*,u.name owner_name from crm_sales_territories t left join users u on u.id=t.default_owner_user_id where t.org_id=${authz.user.orgId} order by priority,name`,
    ) as any,
    db.execute(
      sql`select * from crm_lead_sources where org_id=${authz.user.orgId} order by name`,
    ) as any,
    db.execute(
      sql`select t.*,u.name manager_name from crm_sales_teams t left join users u on u.id=t.manager_user_id where t.org_id=${authz.user.orgId} order by name`,
    ) as any,
    db.execute(
      sql`select q.*,u.name owner_name from crm_sales_quotas q left join users u on u.id=q.owner_user_id where q.org_id=${authz.user.orgId} order by period_start desc`,
    ) as any,
    db.execute(
      sql`select id,name from users where org_id=${authz.user.orgId} and is_active order by name`,
    ) as any,
  ]);
  return (
    <CrmSetupWorkspace
      data={{
        accountStatuses: accountStatuses.rows,
        opportunityStatuses: opportunityStatuses.rows,
        territories: territories.rows,
        sources: sources.rows,
        teams: teams.rows,
        quotas: quotas.rows,
        users: users.rows,
      }}
    />
  );
}
