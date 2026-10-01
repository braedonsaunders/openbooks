import { requireSalesSchema } from "./sales-readiness.ts";
import { SalesError } from "./sales-error.ts";
import {
  acquireOrgFeatureGateLock,
  lockAndCheckOrgFeature,
} from "../organization/org-feature-lock.ts";
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { businessTodayInTx } from "../platform/business-date.ts";
import { orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import {
  matchesTerritory,
  type TerritorySubject,
  type TerritoryRule,
} from "./crm-math.ts";
import {
  geographyMatches,
  hasGeographicCoverage,
} from "./territory-geography.ts";
import type { TerritoryGeography } from "./sales-contracts.ts";

/** Routing changes current responsibility only. Posted sales evidence retains
 * its employee/team attribution independently of the customer master. */
export async function routeSalesAccount(
  tx: SqlExecutor,
  orgId: string,
  profileId: string,
  actorId: string,
): Promise<string | null> {
  await requireSalesSchema(tx);
  await acquireOrgFeatureGateLock(tx, orgId);
  if (!(await lockAndCheckOrgFeature(tx, orgId, "salesManagement")))
    throw new SalesError(
      "Sales management is disabled. Enable it in Company Settings → Features.",
      404,
      "feature_disabled",
    );
  const today = await businessTodayInTx(tx, orgId);
  const row = (
    await tx.execute<{
      id: string;
      party_id: string;
      subsidiary_id: string | null;
      sales_rep_id: string | null;
      territory_id: string | null;
      owner_user_id: string | null;
      country: string | null;
      region: string | null;
      longitude: string | null;
      latitude: string | null;
      industry: string | null;
      lifecycle_stage: TerritorySubject["lifecycleStage"];
      lead_source_id: string | null;
      annual_revenue: string | null;
      employee_count: number | null;
    }>(
      sql`select cp.*,p.subsidiary_id,a.country,a.region,a.longitude::text,a.latitude::text from crm_account_profiles cp join parties p on p.org_id=cp.org_id and p.id=cp.party_id left join lateral(select country,region,longitude,latitude from addresses where org_id=cp.org_id and party_id=cp.party_id order by is_default_billing desc,created_at,id limit 1)a on true where cp.org_id=${orgId} and cp.id=${profileId} for update of cp`,
    )
  ).rows[0];
  if (!row)
    throw new SalesError(
      "Sales account not found. Reload the customer before routing.",
      404,
    );
  const manual = (
    await tx.execute<{ source: string }>(
      sql`select source from crm_account_assignment_events where org_id=${orgId} and account_profile_id=${profileId} order by created_at desc,id desc limit 1`,
    )
  ).rows[0];
  if (manual?.source === "manual") return row.territory_id;
  const candidates = (
    await tx.execute<{
      id: string;
      definition: {
        rules: TerritoryRule[];
        match_mode: "all" | "any";
        geography: TerritoryGeography;
        default_employee_id: string | null;
        sales_team_id: string | null;
      };
    }>(
      sql`select t.id,v.definition from crm_sales_territories t join lateral(select definition from crm_sales_territory_versions v where v.org_id=t.org_id and v.territory_id=t.id and v.effective_from<=${today}::date order by v.effective_from desc,v.revision desc limit 1)v on true where t.org_id=${orgId} and t.is_active and t.lifecycle<>'archived' and t.subsidiary_id is not distinct from ${row.subsidiary_id} order by t.id`,
    )
  ).rows;
  const subject: TerritorySubject = {
    country: row.country,
    region: row.region,
    industry: row.industry,
    lifecycleStage: row.lifecycle_stage,
    leadSourceId: row.lead_source_id,
    annualRevenue: row.annual_revenue,
    employeeCount: row.employee_count,
  };
  const point =
    row.longitude !== null && row.latitude !== null
      ? ([Number(row.longitude), Number(row.latitude)] as [number, number])
      : null;
  const mapEnabled = await orgFeatureEnabled(
    orgId,
    "geographicTerritories",
    tx,
  );
  const matches = candidates.filter((t) => {
    const d = t.definition;
    return (
      (d.rules.length > 0 || hasGeographicCoverage(d.geography)) &&
      (!hasGeographicCoverage(d.geography) || mapEnabled) &&
      (d.rules.length === 0 ||
        matchesTerritory(subject, d.rules, d.match_mode)) &&
      geographyMatches(d.geography, point)
    );
  });
  if (matches.length > 1)
    throw new SalesError(
      "This customer matches multiple published territories. Resolve the overlap in Sales → Territories before routing.",
    );
  const target = matches[0];
  if (!target && manual?.source !== "routing") return row.territory_id;
  const territoryId = target?.id ?? null;
  const representative = target?.definition.default_employee_id ?? null;
  if (representative) {
    const valid = (
      await tx.execute(
        sql`select 1 from employee_roles e join parties p on p.org_id=e.org_id and p.id=e.party_id where e.org_id=${orgId} and e.party_id=${representative} and e.is_active and e.is_sales_rep and p.is_active and p.subsidiary_id is not distinct from ${row.subsidiary_id} and (e.sales_rep_since is null or e.sales_rep_since<=${today}::date) and (e.terminated_on is null or e.terminated_on>=${today}::date) for share of e,p`,
      )
    ).rows.length;
    if (!valid)
      throw new SalesError(
        "The territory representative is no longer eligible. Reassign the territory in Sales → Territories.",
      );
  }
  if (row.territory_id === territoryId && row.sales_rep_id === representative)
    return territoryId;
  const updated = (
    await tx.execute(
      sql`update crm_account_profiles set territory_id=${territoryId},sales_rep_id=${representative},updated_at=clock_timestamp(),updated_by=${actorId} where org_id=${orgId} and id=${profileId} returning id`,
    )
  ).rows;
  if (!updated.length) throw new Error("The sales assignment was not applied.");
  await tx.execute(
    sql`update customer_roles set sales_rep_id=${representative},updated_at=clock_timestamp(),updated_by=${actorId} where org_id=${orgId} and party_id=${row.party_id}`,
  );
  await tx.execute(
    sql`insert into crm_account_assignment_events(org_id,account_profile_id,from_owner_user_id,to_owner_user_id,from_territory_id,to_territory_id,from_employee_id,to_employee_id,source,reason,created_by,updated_by) values(${orgId},${profileId},${row.owner_user_id},${row.owner_user_id},${row.territory_id},${territoryId},${row.sales_rep_id},${representative},'routing','Matched published sales territory',${actorId},${actorId})`,
  );
  await tx.execute(
    sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id) values(${orgId},'crm_account_profiles',${profileId},'update',${JSON.stringify({ before: { territoryId: row.territory_id, employeeId: row.sales_rep_id }, after: { territoryId: territoryId, employeeId: representative }, reason: "Matched published sales territory" })}::jsonb,${actorId})`,
  );
  return territoryId;
}
