import { defineRoute } from "@/lib/api/route";
import { jsonObject } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { isUuid } from "@/lib/list-params";
import {
  addCalendarDays,
  addMonthsStart,
  businessToday,
  startOfMonth,
  isIsoCalendarDate,
} from "@openbooks/engine/platform/business-date/module";
import { calculateForecast } from "@/lib/crm";
import { createCrmForecastSnapshot } from "@/lib/crm/forecasts";

export const runtime = "nodejs";

export const GET = defineRoute({
  permission: "crm.forecasts.read",
  feature: "crm",
  handler: async ({ request: req, authz: gate }) => {
    const params = new URL(req.url).searchParams;
    const today = await businessToday(gate.user.orgId);
    const defaultStart = startOfMonth(today);
    const defaultEnd = addCalendarDays(addMonthsStart(defaultStart, 3), -1);
    const periodStart = params.get("periodStart") ?? defaultStart;
    const periodEnd = params.get("periodEnd") ?? defaultEnd;
    const ownerUserId = params.get("ownerUserId");
    const salesTeamId = params.get("salesTeamId");
    if (!isIsoCalendarDate(periodStart) || !isIsoCalendarDate(periodEnd) || periodEnd < periodStart)
      return NextResponse.json({ error: "invalid forecast period" }, { status: 422 });
    if (ownerUserId && !isUuid(ownerUserId))
      return NextResponse.json({ error: "invalid owner" }, { status: 422 });
    if (salesTeamId && !isUuid(salesTeamId))
      return NextResponse.json({ error: "invalid sales team" }, { status: 422 });
    // Quotas carry no subsidiary lineage, so a subsidiary-restricted caller
    // must not receive them at all: a quota for an owner or team whose
    // opportunities sit in another entity would leak across the boundary.
    // Fail closed with an explicit notice instead of an empty-looking list.
    const quotasRestricted = gate.allowedSubsidiaryIds !== null;
    const [forecast, quotas, snapshots] = await Promise.all([
      calculateForecast({
        orgId: gate.user.orgId,
        periodStart,
        periodEnd,
        ownerUserId,
        salesTeamId,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      }),
      quotasRestricted
        ? Promise.resolve([])
        : db.execute(
            sql`
        select q.*, u.display_name as owner_name, t.name as sales_team_name from crm_sales_quotas q
        left join parties u on u.id = q.employee_id and u.org_id=q.org_id left join crm_sales_teams t on t.id = q.sales_team_id and t.org_id = q.org_id
        where q.org_id = ${gate.user.orgId} and q.lifecycle='approved' and q.period_start <= ${periodEnd}::date and q.period_end >= ${periodStart}::date
          ${ownerUserId ? sql`and q.employee_id = (select party_id from users where id=${ownerUserId} and org_id=q.org_id)` : sql``}
          ${salesTeamId ? sql`and q.sales_team_id = ${salesTeamId}` : sql``}
        order by q.period_start, coalesce(u.display_name, t.name)`,
            "objects",
          ),
      db.execute(
        sql`
        select s.*, u.name as owner_name, t.name as sales_team_name from crm_forecast_snapshots s
        left join users u on u.id = s.owner_user_id left join crm_sales_teams t on t.id = s.sales_team_id and t.org_id = s.org_id
        where s.org_id = ${gate.user.orgId} and ${gate.allowedSubsidiaryIds === null} and s.period_start = ${periodStart}::date and s.period_end = ${periodEnd}::date
          ${ownerUserId ? sql`and s.owner_user_id = ${ownerUserId}` : sql``}
          ${salesTeamId ? sql`and s.sales_team_id = ${salesTeamId}` : sql``}
        order by s.as_of desc limit 50`,
        "objects",
      ),
    ]);
    const t = await getTranslations("crm");
    return NextResponse.json({
      periodStart,
      periodEnd,
      forecast,
      quotas,
      snapshots,
      quotasNotice: quotasRestricted ? t("forecasts.quotasRestrictedNotice") : null,
    });
  },
});

export const POST = defineRoute({
  permission: "crm.forecasts.manage",
  feature: "crm",
  body: jsonObject,
  handler: async ({ authz: gate, body }) => {
    const t = await getTranslations("crm");
    const result = await createCrmForecastSnapshot(gate, body, {
      invalidOwnerTarget: t("forecasts.invalidOwnerTarget"),
      invalidTeamTarget: t("forecasts.invalidTeamTarget"),
      ownerOutsideOrganization: t("forecasts.ownerOutsideOrganization"),
      teamOutsideOrganization: t("forecasts.teamOutsideOrganization"),
    });
    return result instanceof NextResponse ? result : NextResponse.json(result, { status: 201 });
  },
});
