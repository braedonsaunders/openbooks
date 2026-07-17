import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { ensureCrmDefaults } from "@openbooks/engine/src/crm.ts";
import { requirePermission } from "../../../../../lib/authz";
import {
  isUuid,
  parseListParams,
  pickString,
} from "../../../../../lib/list-params";
import { CrmSetupWorkspace, type CrmSetupTab } from "./CrmSetupWorkspace";

export const dynamic = "force-dynamic";

const TABS: CrmSetupTab[] = [
  "accountStatuses",
  "opportunityStatuses",
  "sources",
  "territories",
  "teams",
  "quotas",
];

export default async function CrmSetup({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const authz = await requirePermission("crm.setup.manage");
  const orgId = authz.user.orgId;
  const sp = await searchParams;
  const requestedTab = pickString(sp.tab) as CrmSetupTab | undefined;
  const tab =
    requestedTab && TABS.includes(requestedTab)
      ? requestedTab
      : "accountStatuses";
  const list = parseListParams(sp, {
    sort: "default",
    allowedSorts: ["default"] as const,
    perPage: 25,
  });
  const offset = (list.page - 1) * list.perPage;
  const term = `%${list.q ?? ""}%`;

  await ensureCrmDefaults(orgId, authz.user.id);

  let rowsResult: any;
  let countResult: any;
  if (tab === "accountStatuses") {
    [rowsResult, countResult] = await Promise.all([
      db.execute(sql`
        select * from crm_account_statuses
         where org_id=${orgId} ${list.q ? sql`and (name ilike ${term} or description ilike ${term} or lifecycle_stage ilike ${term})` : sql``}
         order by lifecycle_stage, sequence, name limit ${list.perPage} offset ${offset}`),
      db.execute(
        sql`select count(*)::int n from crm_account_statuses where org_id=${orgId} ${list.q ? sql`and (name ilike ${term} or description ilike ${term} or lifecycle_stage ilike ${term})` : sql``}`,
      ),
    ]);
  } else if (tab === "opportunityStatuses") {
    [rowsResult, countResult] = await Promise.all([
      db.execute(sql`
        select * from crm_opportunity_statuses
         where org_id=${orgId} ${list.q ? sql`and (name ilike ${term} or description ilike ${term} or default_forecast_category ilike ${term})` : sql``}
         order by sequence, name limit ${list.perPage} offset ${offset}`),
      db.execute(
        sql`select count(*)::int n from crm_opportunity_statuses where org_id=${orgId} ${list.q ? sql`and (name ilike ${term} or description ilike ${term} or default_forecast_category ilike ${term})` : sql``}`,
      ),
    ]);
  } else if (tab === "sources") {
    [rowsResult, countResult] = await Promise.all([
      db.execute(sql`
        select * from crm_lead_sources
         where org_id=${orgId} ${list.q ? sql`and (name ilike ${term} or description ilike ${term})` : sql``}
         order by name limit ${list.perPage} offset ${offset}`),
      db.execute(
        sql`select count(*)::int n from crm_lead_sources where org_id=${orgId} ${list.q ? sql`and (name ilike ${term} or description ilike ${term})` : sql``}`,
      ),
    ]);
  } else if (tab === "territories") {
    [rowsResult, countResult] = await Promise.all([
      db.execute(sql`
        select t.*, u.name owner_name, m.name manager_name
          from crm_sales_territories t
          left join users u on u.id=t.default_owner_user_id
          left join users m on m.id=t.manager_user_id
         where t.org_id=${orgId} ${list.q ? sql`and (t.name ilike ${term} or t.description ilike ${term} or u.name ilike ${term} or m.name ilike ${term})` : sql``}
         order by t.priority, t.name limit ${list.perPage} offset ${offset}`),
      db.execute(sql`
        select count(*)::int n from crm_sales_territories t
        left join users u on u.id=t.default_owner_user_id
        left join users m on m.id=t.manager_user_id
        where t.org_id=${orgId} ${list.q ? sql`and (t.name ilike ${term} or t.description ilike ${term} or u.name ilike ${term} or m.name ilike ${term})` : sql``}`),
    ]);
  } else if (tab === "teams") {
    [rowsResult, countResult] = await Promise.all([
      db.execute(sql`
        select t.*, u.name manager_name, count(tm.id)::int member_count
          from crm_sales_teams t
          left join users u on u.id=t.manager_user_id
          left join crm_sales_team_members tm on tm.team_id=t.id and tm.is_active
         where t.org_id=${orgId} ${list.q ? sql`and (t.name ilike ${term} or u.name ilike ${term})` : sql``}
         group by t.id, u.name order by t.name limit ${list.perPage} offset ${offset}`),
      db.execute(sql`
        select count(*)::int n from crm_sales_teams t left join users u on u.id=t.manager_user_id
        where t.org_id=${orgId} ${list.q ? sql`and (t.name ilike ${term} or u.name ilike ${term})` : sql``}`),
    ]);
  } else {
    [rowsResult, countResult] = await Promise.all([
      db.execute(sql`
        select q.*, coalesce(u.name,t.name) target_name
          from crm_sales_quotas q
          left join users u on u.id=q.owner_user_id
          left join crm_sales_teams t on t.id=q.sales_team_id
         where q.org_id=${orgId} ${list.q ? sql`and (u.name ilike ${term} or t.name ilike ${term} or q.currency ilike ${term})` : sql``}
         order by q.period_start desc, target_name limit ${list.perPage} offset ${offset}`),
      db.execute(sql`
        select count(*)::int n from crm_sales_quotas q
        left join users u on u.id=q.owner_user_id left join crm_sales_teams t on t.id=q.sales_team_id
        where q.org_id=${orgId} ${list.q ? sql`and (u.name ilike ${term} or t.name ilike ${term} or q.currency ilike ${term})` : sql``}`),
    ]);
  }

  const [usersResult, teamsResult, orgResult] = (await Promise.all([
    db.execute(
      sql`select id,name from users where org_id=${orgId} and is_active order by name`,
    ),
    db.execute(
      sql`select id,name from crm_sales_teams where org_id=${orgId} and is_active order by name`,
    ),
    db.execute(sql`select base_currency from orgs where id=${orgId}`),
  ])) as any[];

  const rowParam = pickString(sp.row);
  const creating = rowParam === "new";
  let selected: Record<string, any> | null = null;
  if (rowParam && rowParam !== "new" && isUuid(rowParam)) {
    let selectedResult: any;
    if (tab === "accountStatuses")
      selectedResult = await db.execute(
        sql`select * from crm_account_statuses where id=${rowParam} and org_id=${orgId}`,
      );
    else if (tab === "opportunityStatuses")
      selectedResult = await db.execute(
        sql`select * from crm_opportunity_statuses where id=${rowParam} and org_id=${orgId}`,
      );
    else if (tab === "sources")
      selectedResult = await db.execute(
        sql`select * from crm_lead_sources where id=${rowParam} and org_id=${orgId}`,
      );
    else if (tab === "territories")
      selectedResult = await db.execute(
        sql`select * from crm_sales_territories where id=${rowParam} and org_id=${orgId}`,
      );
    else if (tab === "teams")
      selectedResult = await db.execute(
        sql`select * from crm_sales_teams where id=${rowParam} and org_id=${orgId}`,
      );
    else
      selectedResult = await db.execute(
        sql`select * from crm_sales_quotas where id=${rowParam} and org_id=${orgId}`,
      );
    selected = selectedResult.rows[0] ?? null;
    if (selected && tab === "teams") {
      const members = (await db.execute(
        sql`select user_id,role from crm_sales_team_members where team_id=${rowParam} and org_id=${orgId} and is_active order by role,user_id`,
      )) as any;
      selected.members = members.rows.map((member: any) => ({
        userId: member.user_id,
        role: member.role,
      }));
    }
  }

  return (
    <CrmSetupWorkspace
      tab={tab}
      rows={rowsResult.rows}
      selected={selected}
      creating={creating}
      total={Number(countResult.rows[0]?.n ?? 0)}
      page={list.page}
      perPage={list.perPage}
      currentParams={sp}
      users={usersResult.rows}
      teams={teamsResult.rows}
      baseCurrency={orgResult.rows[0]?.base_currency ?? ""}
    />
  );
}
