import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import type { Authz } from "./authz";
import { insightVisibilitySql } from "./insight-access";

/** Change a personal dashboard pin after applying the same visibility fence as the dashboard page. */
export async function setInsightDashboardPin(
  authz: Authz,
  dashboardId: string,
  pin: boolean,
): Promise<boolean | null> {
  const visible = await db.execute(
    sql`select 1 from insight_dashboards where id = ${dashboardId} and org_id = ${authz.user.orgId} and ${insightVisibilitySql(authz)} limit 1`,
    "objects",
  );
  if (!visible[0]) return null;

  if (!pin) {
    await db.execute(sql`
      delete from insight_dashboard_pins
       where org_id = ${authz.user.orgId} and user_id = ${authz.user.id} and dashboard_id = ${dashboardId}
    `);
    return false;
  }

  const next = await db.execute<{ n: number }>(
    sql`
    select coalesce(max(sort_order), -1) + 1 as n
      from insight_dashboard_pins
     where org_id = ${authz.user.orgId} and user_id = ${authz.user.id}
  `,
    "objects",
  );
  await db.execute(sql`
    insert into insight_dashboard_pins (org_id, user_id, dashboard_id, sort_order)
    values (${authz.user.orgId}, ${authz.user.id}, ${dashboardId}, ${next[0]?.n ?? 0})
    on conflict (org_id, user_id, dashboard_id) do nothing
  `);
  return true;
}
