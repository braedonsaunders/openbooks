import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";
import { SalesError } from "./sales-error.ts";

/** Runtime compatibility for the expand-schema-first Sales rollout. A missing
 * schema never produces financial zeroes or permits partially native writes. */
export async function salesSchemaReady(tx: SqlExecutor = db): Promise<boolean> {
  const result = await tx.execute<{ ready: boolean }>(sql`select
    exists(select 1 from information_schema.columns where table_schema='public' and table_name='employee_roles' and column_name='is_sales_rep')
    and exists(select 1 from information_schema.columns where table_schema='public' and table_name='crm_sales_quotas' and column_name='employee_id')
    and exists(select 1 from information_schema.columns where table_schema='public' and table_name='crm_sales_quotas' and column_name='lifecycle')
    and exists(select 1 from information_schema.columns where table_schema='public' and table_name='crm_sales_team_members' and column_name='employee_id')
    and exists(select 1 from information_schema.columns where table_schema='public' and table_name='crm_account_profiles' and column_name='sales_rep_id')
    and exists(select 1 from information_schema.tables where table_schema='public' and table_name='crm_sales_evidence')
    and exists(select 1 from information_schema.tables where table_schema='public' and table_name='crm_sales_territory_versions') as ready`);
  return result.rows[0]?.ready === true;
}
export async function requireSalesSchema(tx: SqlExecutor = db): Promise<void> {
  if (!(await salesSchemaReady(tx)))
    throw new SalesError(
      "The employee-backed Sales database upgrade is pending. Ask your administrator to apply the Sales management migration before saving or routing assignments.",
      409,
      "sales_upgrade_required",
    );
}
