import "server-only";
import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "@openbooks/engine/platform/database";
import { salesScopeWhere } from "@openbooks/engine/crm/sales";
import type {
  SalesCustomerLocation,
  SalesScope,
} from "@openbooks/engine/crm/sales/contracts";

export type SalesMapFilters = {
  subsidiaryId: string | null;
  departmentId: string | null;
  salesTeamId: string | null;
  employeeId: string | null;
};

/** Map coordinates stay inside the application. The canonical billing address
 * is plotted only after verification, with the same tenant and entity scope
 * as the customer record. Missing coordinates remain an explicit count. */
export async function loadSalesMapCustomers(
  scope: SalesScope,
  filters: SalesMapFilters,
  tx: SqlExecutor = db,
) {
  const relation = sql`customer_roles c join parties p on p.org_id=c.org_id and p.id=c.party_id
    left join employee_roles rep on rep.org_id=c.org_id and rep.party_id=c.sales_rep_id
    left join crm_account_profiles cp on cp.org_id=c.org_id and cp.party_id=c.party_id
    left join crm_sales_territories territory on territory.org_id=cp.org_id and territory.id=cp.territory_id
    left join lateral (select latitude,longitude,location_verified_at from addresses where org_id=p.org_id and party_id=p.id order by is_default_billing desc,created_at,id limit 1) address on true`;
  const where = sql`c.org_id=${scope.orgId} and c.is_active and p.is_active and ${salesScopeWhere(scope, sql`p.subsidiary_id`)}
    and (${filters.subsidiaryId}::uuid is null or p.subsidiary_id=${filters.subsidiaryId}::uuid)
    and (${filters.departmentId}::uuid is null or rep.department_id=${filters.departmentId}::uuid)
    and (${filters.employeeId}::uuid is null or c.sales_rep_id=${filters.employeeId}::uuid)
    and (${filters.salesTeamId}::uuid is null or territory.sales_team_id=${filters.salesTeamId}::uuid)`;
  const located = sql`address.latitude is not null and address.longitude is not null and address.location_verified_at is not null`;
  const stats = (
    await tx.execute<{ total: number; located: number }>(
      sql`select count(*)::int as total,count(*) filter(where ${located})::int as located from ${relation} where ${where}`,
    )
  ).rows[0] ?? { total: 0, located: 0 };
  const locations = (
    await tx.execute<SalesCustomerLocation>(
      sql`select p.id,p.display_name as name,address.longitude::float8 as longitude,address.latitude::float8 as latitude,c.sales_rep_id as "employeeId",cp.territory_id as "territoryId" from ${relation} where ${where} and ${located} order by p.display_name,p.id limit 5000`,
    )
  ).rows;
  return { locations, stats };
}
