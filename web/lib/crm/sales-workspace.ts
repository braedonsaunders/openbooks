import { EMPTY_TERRITORY_GEOGRAPHY } from "@openbooks/engine/crm/sales/contracts";
import "server-only";
import { ensureReportDefinitions } from "@openbooks/engine/reports/definitions";
import { sql } from "drizzle-orm";
import { notFound } from "next/navigation";
import { db } from "@openbooks/engine/platform/database";
import {
  businessToday,
  isIsoCalendarDate,
} from "@openbooks/engine/platform/business-date";
import { salesScopeWhere } from "@openbooks/engine/crm/sales";
import type {
  SalesOption,
  SalesPage,
  SalesRecord,
  SalesWorkspaceData,
} from "@openbooks/engine/crm/sales/contracts";
import { can, getAuthz, requirePermission } from "@/lib/authz";
import { requireFeatureEnabled } from "@/lib/feature-gates";
import { isFeatureEnabled } from "@/lib/features";
import { isUuid, parseListParams } from "@/lib/list-params";

export async function loadSalesWorkspace(
  page: SalesPage,
  params: Record<string, string | undefined>,
): Promise<SalesWorkspaceData> {
  const existingAuthz = await getAuthz();
  const authz =
    existingAuthz && can(existingAuthz, "crm.setup.manage")
      ? existingAuthz
      : await requirePermission("crm.forecasts.read");
  const { orgId, id: actorId } = authz.user;
  await requireFeatureEnabled(orgId, "salesManagement");
  const scope = {
    orgId,
    actorId,
    allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
  };
  await ensureReportDefinitions(orgId);
  const reportRows = (
    await db.execute<{ id: string; slug: string }>(
      sql`select id,slug from report_definitions where org_id=${orgId} and slug in ('sales-evidence','sales-quota-attainment') and archived_at is null`,
    )
  ).rows;
  const reports = {
    quota:
      "/reports/custom/run/" +
      (reportRows.find((r) => r.slug === "sales-quota-attainment")?.id ?? ""),
    evidence:
      "/reports/custom/run/" +
      (reportRows.find((r) => r.slug === "sales-evidence")?.id ?? ""),
  };
  if (!reportRows.some((r) => r.slug === "sales-quota-attainment"))
    reports.quota = "/reports";
  if (!reportRows.some((r) => r.slug === "sales-evidence"))
    reports.evidence = "/reports";
  const quotaOptions = (
    await db.execute<
      SalesOption & { lifecycle: string; sales_team_id: string | null }
    >(
      sql`select id,name,subsidiary_id,lifecycle,sales_team_id from crm_sales_quotas where org_id=${orgId} and lifecycle in ('draft','approved') and ${salesScopeWhere(scope, sql`subsidiary_id`)} order by name,id`,
    )
  ).rows;
  const today = await businessToday(orgId);
  const periodStart =
    params.periodStart && isIsoCalendarDate(params.periodStart)
      ? params.periodStart
      : today.slice(0, 7) + "-01";
  const periodEnd =
    params.periodEnd && isIsoCalendarDate(params.periodEnd)
      ? params.periodEnd
      : today;
  const {
    q,
    page: currentPage,
    perPage,
  } = parseListParams(params, {
    sort: "name",
    allowedSorts: ["name"],
    dir: "asc",
  });
  const organization = (
    await db.execute<{ base_currency: string }>(
      sql`select base_currency from orgs where id=${orgId}`,
    )
  ).rows[0]!;
  const employees = (
    await db.execute<SalesOption & { is_sales_rep: boolean }>(
      sql`select p.id,p.display_name as name,p.subsidiary_id,e.is_sales_rep from employee_roles e join parties p on p.id=e.party_id and p.org_id=e.org_id where e.org_id=${orgId} and e.is_active and p.is_active and ${salesScopeWhere(scope, sql`p.subsidiary_id`)} order by p.display_name,p.id`,
    )
  ).rows;
  const teams = (
    await db.execute<SalesOption>(
      sql`select id,name,subsidiary_id from crm_sales_teams where org_id=${orgId} and is_active and ${salesScopeWhere(scope, sql`subsidiary_id`)} order by name,id`,
    )
  ).rows;
  const subsidiaries = (
    await db.execute<SalesOption>(
      sql`select id,name,id as subsidiary_id from subsidiaries where org_id=${orgId} and is_active and ${salesScopeWhere(scope, sql`id`)} order by name,id`,
    )
  ).rows;
  const currencies = (
    await db.execute<{ code: string; name: string }>(
      sql`select code,name from currencies order by code`,
    )
  ).rows;
  const relation =
    page === "representatives"
      ? sql`employee_roles e join parties p on p.org_id=e.org_id and p.id=e.party_id`
      : page === "teams"
        ? sql`crm_sales_teams e left join parties p on p.org_id=e.org_id and p.id=e.manager_employee_id`
        : page === "territories"
          ? sql`crm_sales_territories e left join parties p on p.org_id=e.org_id and p.id=e.default_employee_id`
          : sql`crm_sales_quotas e left join parties p on p.org_id=e.org_id and p.id=e.employee_id left join crm_sales_teams t on t.org_id=e.org_id and t.id=e.sales_team_id`;
  const fields =
    page === "representatives"
      ? sql`e.*,e.party_id as id,p.display_name as name,p.subsidiary_id,e.updated_at::text,0 as revision,e.sales_rep_since::text`
      : page === "teams"
        ? sql`e.*,p.display_name as manager_name,(select count(*)::int from crm_sales_team_members m where m.org_id=e.org_id and m.team_id=e.id and m.is_active and m.valid_from<=${today}::date and (m.valid_to is null or m.valid_to>=${today}::date)) as member_count`
        : page === "territories"
          ? sql`e.*,e.effective_from::text,p.display_name as employee_name`
          : sql`e.*,e.period_start::text,e.period_end::text,e.amount::text,coalesce(p.display_name,t.name) as employee_name,t.name as team_name,coalesce((select sum(v.amount) from crm_sales_evidence v where v.org_id=e.org_id and v.subsidiary_id is not distinct from e.subsidiary_id and v.metric=e.metric and v.currency=e.currency and v.effective_date between e.period_start and e.period_end and ((e.employee_id is not null and v.employee_id=e.employee_id) or (e.sales_team_id is not null and v.sales_team_id=e.sales_team_id))),0)::text as actual`;
  const entity =
    page === "representatives" ? sql`p.subsidiary_id` : sql`e.subsidiary_id`;
  const name = page === "representatives" ? sql`p.display_name` : sql`e.name`;
  const where = sql`e.org_id=${orgId} and ${salesScopeWhere(scope, entity)} and (${q ?? ""}='' or ${name} ilike ${"%" + (q ?? "") + "%"})`;
  const total =
    page === "overview"
      ? 0
      : Number(
          (
            await db.execute<{ n: number }>(
              sql`select count(*)::int as n from ${relation} where ${where}`,
            )
          ).rows[0]?.n ?? 0,
        );
  const rows =
    page === "overview"
      ? []
      : (
          await db.execute<SalesRecord>(
            sql`select ${fields} from ${relation} where ${where} order by ${name},e.id limit ${perPage} offset ${(currentPage - 1) * perPage}`,
          )
        ).rows;
  let selected: SalesRecord | null = null;
  const requestedRecord = params.row === "new" ? params.revises : params.row;
  if (requestedRecord && requestedRecord !== "new") {
    if (!isUuid(requestedRecord) || page === "overview") notFound();
    const identity = page === "representatives" ? sql`e.party_id` : sql`e.id`;
    selected =
      (
        await db.execute<SalesRecord>(
          sql`select ${fields} from ${relation} where e.org_id=${orgId} and ${salesScopeWhere(scope, entity)} and ${identity}=${requestedRecord}`,
        )
      ).rows[0] ?? null;
    if (!selected) notFound();
    if (page === "teams")
      selected.members = (
        await db.execute<{
          employeeId: string;
          role: "manager" | "member";
          validFrom: string;
          validTo: string | null;
        }>(
          sql`select employee_id as "employeeId",role,valid_from::text as "validFrom",valid_to::text as "validTo" from crm_sales_team_members where org_id=${orgId} and team_id=${selected.id} and is_active order by employee_id`,
        )
      ).rows;
  }
  if (page === "territories") {
    // Masked sandbox coverage has no published version and must be reviewed
    // before it can become operational again.
    for (const record of [...rows, ...(selected ? [selected] : [])])
      if (
        !Array.isArray(record.geography?.includes) ||
        !Array.isArray(record.geography?.excludes) ||
        !Array.isArray(record.geography?.polygons)
      )
        record.geography = EMPTY_TERRITORY_GEOGRAPHY;
  }
  const counts = (
    await db.execute<SalesWorkspaceData["counts"]>(sql`select
    (select count(*)::int from employee_roles e join parties p on p.org_id=e.org_id and p.id=e.party_id where e.org_id=${orgId} and e.is_sales_rep and e.is_active and p.is_active and ${salesScopeWhere(scope, sql`p.subsidiary_id`)}) as representatives,
    (select count(*)::int from crm_sales_teams where org_id=${orgId} and is_active and ${salesScopeWhere(scope, sql`subsidiary_id`)}) as teams,
    (select count(*)::int from crm_sales_territories where org_id=${orgId} and is_active and ${salesScopeWhere(scope, sql`subsidiary_id`)}) as territories,
    (select count(*)::int from crm_sales_quotas where org_id=${orgId} and lifecycle in ('draft','pending_approval') and ${salesScopeWhere(scope, sql`subsidiary_id`)}) as "draftQuotas",
    (select count(*)::int from crm_sales_evidence where org_id=${orgId} and employee_id is null and ${salesScopeWhere(scope, sql`subsidiary_id`)}) as unattributed,
    (select count(*)::int from crm_sales_evidence where org_id=${orgId} and effective_date is null and ${salesScopeWhere(scope, sql`subsidiary_id`)}) as undated`)
  ).rows[0]!;
  const summary = (
    await db.execute<SalesWorkspaceData["summary"][number]>(
      sql`with q as (select currency,metric,sum(amount) as quota from crm_sales_quotas where org_id=${orgId} and lifecycle='approved' and parent_quota_id is null and period_start=${periodStart}::date and period_end=${periodEnd}::date and ${salesScopeWhere(scope, sql`subsidiary_id`)} group by currency,metric), a as (select currency,metric,sum(amount) as actual from crm_sales_evidence where org_id=${orgId} and effective_date between ${periodStart}::date and ${periodEnd}::date and ${salesScopeWhere(scope, sql`subsidiary_id`)} group by currency,metric) select coalesce(q.currency,a.currency) as currency,coalesce(q.metric,a.metric) as metric,coalesce(q.quota,0)::text as quota,coalesce(a.actual,0)::text as actual from q full join a using(currency,metric) order by currency,metric`,
    )
  ).rows;
  return {
    reports,
    quotaOptions,
    page,
    rows,
    total,
    currentPage,
    perPage,
    employees,
    representatives: employees.filter((e) => e.is_sales_rep),
    teams,
    subsidiaries,
    currencies,
    baseCurrency: organization.base_currency,
    multiCurrency: await isFeatureEnabled(orgId, "multiCurrency"),
    mapEnabled: await isFeatureEnabled(orgId, "geographicTerritories"),
    canManage: can(authz, "crm.setup.manage"),
    canApprove: can(authz, "crm.forecasts.override"),
    selected,
    creating: params.row === "new",
    periodStart,
    periodEnd,
    summary,
    counts,
  };
}
