import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { normalizeMoneyValue } from "../cash/core";
import { crmOpportunityScope } from "../crm-scope";
import { isFeatureEnabled } from "../features";
import { clamp } from "../list-params";
import type { ApplicationContext } from "./context";
import { assertApplicationPermission } from "./context";
import { ApplicationError } from "./errors";

/**
 * Sales opportunities — same scope and row shape as `search_opportunities`
 * and the CRM opportunities list. Amounts stay exact decimal strings.
 */
export async function listApplicationOpportunities(
  context: ApplicationContext,
  input: { query?: string; openOnly?: boolean; limit?: number },
) {
  assertApplicationPermission(context, "crm.opportunities.read");
  if (!(await isFeatureEnabled(context.authz.user.orgId, "crm"))) {
    throw new ApplicationError(
      "not_found",
      "crm is off; enable it from GET /api/v1/settings/features",
      404,
    );
  }
  const limit = clamp(input.limit ?? 50, 1, 200);
  const like = input.query?.trim() ? `%${input.query.trim()}%` : null;
  const filters = sql.join(
    [
      like
        ? sql` and (o.title ilike ${like} or o.opportunity_number ilike ${like} or p.display_name ilike ${like})`
        : sql``,
      input.openOnly ? sql` and not s.is_closed` : sql``,
    ],
    sql``,
  );
  const scope = crmOpportunityScope(context.authz.allowedSubsidiaryIds);
  const [page, totals] = await Promise.all([
    db.execute<Record<string, unknown>>(sql`
      select o.id, o.opportunity_number, o.title, o.expected_close_date::text as expected_close_date,
             o.forecast_category, o.probability, o.currency,
             o.projected_amount::text as projected_amount,
             o.weighted_amount::text as weighted_amount, o.is_active,
             s.name as status_name, s.is_closed, s.is_won,
             p.display_name as party_name, u.name as owner_name
        from crm_opportunities o
        join crm_opportunity_statuses s on s.id = o.status_id and s.org_id = o.org_id
        left join parties p on p.id = o.party_id and p.org_id = o.org_id
        left join users u on u.id = o.owner_user_id
       where o.org_id = ${context.authz.user.orgId}${filters}${scope}
       order by s.is_closed, o.expected_close_date nulls last, o.created_at desc
       limit ${limit}
    `),
    db.execute<Record<string, unknown>>(sql`
      select count(*)::int as count, o.currency,
             coalesce(sum(o.projected_amount), 0)::text as projected,
             coalesce(sum(o.weighted_amount), 0)::text as weighted
        from crm_opportunities o
        join crm_opportunity_statuses s on s.id = o.status_id and s.org_id = o.org_id
        left join parties p on p.id = o.party_id and p.org_id = o.org_id
       where o.org_id = ${context.authz.user.orgId}${filters}${scope}
       group by o.currency order by o.currency
    `),
  ]);
  return {
    total: totals.rows.reduce((n, row) => n + Number(row.count ?? 0), 0),
    opportunities: page.rows.map((row) => ({
      id: row.id,
      opportunityNumber: row.opportunity_number,
      title: row.title,
      customerName: row.party_name,
      ownerName: row.owner_name,
      statusName: row.status_name,
      isClosed: row.is_closed,
      isWon: row.is_won,
      forecastCategory: row.forecast_category,
      probability: row.probability,
      currency: row.currency,
      projectedAmount: normalizeMoneyValue(String(row.projected_amount ?? "0")),
      weightedAmount: normalizeMoneyValue(String(row.weighted_amount ?? "0")),
      expectedCloseDate: row.expected_close_date,
      isActive: row.is_active,
    })),
    totalsByCurrency: totals.rows.map((row) => ({
      currency: row.currency,
      count: Number(row.count ?? 0),
      projectedAmount: normalizeMoneyValue(String(row.projected ?? "0")),
      weightedAmount: normalizeMoneyValue(String(row.weighted ?? "0")),
    })),
  };
}
