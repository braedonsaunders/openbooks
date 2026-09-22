import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { normalizeMoneyValue } from "../cash/core";
import { loadCrmAccount, loadOpportunity } from "../crm";
import { crmOpportunityScope, crmSharedScope } from "../crm-scope";
import { isFeatureEnabled } from "../features";
import { clamp, isUuid } from "../list-params";
import type { ApplicationContext } from "./context";
import { assertApplicationPermission } from "./context";
import { ApplicationError, invalidInput, notFound } from "./errors";

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

function crmOff(): never {
  throw new ApplicationError(
    "not_found",
    "crm is off; enable it from GET /api/v1/settings/features",
    404,
  );
}

function money(value: unknown): string {
  return normalizeMoneyValue(String(value ?? "0"));
}

/** One opportunity — same `loadOpportunity` loader as the opportunity drawer. */
export async function getApplicationOpportunity(context: ApplicationContext, opportunityId: string) {
  assertApplicationPermission(context, "crm.opportunities.read");
  if (!(await isFeatureEnabled(context.authz.user.orgId, "crm"))) crmOff();
  if (!isUuid(opportunityId)) throw invalidInput("opportunity id must be a UUID");
  const loaded = await loadOpportunity(
    opportunityId,
    context.authz.user.orgId,
    context.authz.allowedSubsidiaryIds,
  );
  if (!loaded) throw notFound("opportunity");
  const head = loaded.opportunity as Record<string, unknown>;
  return {
    opportunity: {
      id: head.id,
      opportunityNumber: head.opportunity_number,
      title: head.title,
      customerName: head.party_name,
      contactName: head.contact_name,
      ownerName: head.owner_name,
      salesTeamName: head.sales_team_name,
      leadSourceName: head.lead_source_name,
      statusName: head.status_name,
      isClosed: head.is_closed,
      isWon: head.is_won,
      forecastCategory: head.forecast_category,
      probability: head.probability,
      currency: head.currency,
      projectedAmount: money(head.projected_amount),
      weightedAmount: money(head.weighted_amount),
      rangeLow: head.range_low == null ? null : money(head.range_low),
      rangeHigh: head.range_high == null ? null : money(head.range_high),
      expectedCloseDate: head.expected_close_date,
      nextStep: head.next_step,
      description: head.description,
      isActive: head.is_active,
    },
    lines: (loaded.lines as Record<string, unknown>[]).map((line) => ({
      lineNumber: line.line_number,
      description: line.description,
      quantity: line.quantity == null ? null : String(line.quantity),
      unit: line.unit,
      unitPrice: line.unit_price == null ? null : money(line.unit_price),
      amount: money(line.amount),
      expectedAmount: line.expected_amount == null ? null : money(line.expected_amount),
    })),
    team: (loaded.team as Record<string, unknown>[]).map((member) => ({
      userName: member.user_name,
      userEmail: member.user_email,
      isPrimary: member.is_primary,
      role: member.role,
    })),
    documents: (loaded.documents as Record<string, unknown>[]).map((doc) => ({
      documentId: doc.id,
      kind: doc.kind,
      documentNumber: doc.document_number,
      documentDate: doc.document_date,
      status: doc.status,
      currency: doc.currency,
      total: money(doc.total),
    })),
    activities: (loaded.activities as Record<string, unknown>[]).map((activity) => ({
      activityId: activity.id,
      kind: activity.kind,
      status: activity.status,
      subject: activity.subject,
      startsAt: activity.starts_at,
      dueAt: activity.due_at,
      completedAt: activity.completed_at,
    })),
    history: (loaded.history as Record<string, unknown>[]).map((event) => ({
      fromStatus: event.from_status_name,
      toStatus: event.to_status_name,
      actorName: event.actor_name,
      occurredAt: event.occurred_at,
      note: event.note,
    })),
  };
}

/** CRM accounts — same query shape as `search_crm_accounts`. */
export async function listApplicationCrmAccounts(
  context: ApplicationContext,
  input: { query?: string; stage?: string; limit?: number },
) {
  assertApplicationPermission(context, "crm.accounts.read");
  if (!(await isFeatureEnabled(context.authz.user.orgId, "crm"))) crmOff();
  if (input.stage && input.stage !== "lead" && input.stage !== "prospect" && input.stage !== "customer") {
    throw invalidInput("stage must be lead, prospect, or customer");
  }
  const limit = clamp(input.limit ?? 50, 1, 200);
  const like = input.query?.trim() ? `%${input.query.trim()}%` : null;
  const filters = sql.join(
    [
      like ? sql` and p.display_name ilike ${like}` : sql``,
      input.stage ? sql` and cp.lifecycle_stage = ${input.stage}` : sql``,
    ],
    sql``,
  );
  const scope = crmSharedScope(sql`p.subsidiary_id`, context.authz.allowedSubsidiaryIds);
  const [page, stages] = await Promise.all([
    db.execute<Record<string, unknown>>(sql`
      select cp.party_id, p.display_name, cp.lifecycle_stage,
             s.name as status_name, s.is_qualified,
             u.name as owner_name, t.name as territory_name, ls.name as lead_source_name,
             cp.qualification_score, cp.next_action_at, cp.last_activity_at, cp.is_active
        from crm_account_profiles cp
        join parties p on p.id = cp.party_id and p.org_id = cp.org_id
        left join crm_account_statuses s on s.id = cp.status_id and s.org_id = cp.org_id
        left join users u on u.id = cp.owner_user_id
        left join crm_sales_territories t on t.id = cp.territory_id and t.org_id = cp.org_id
        left join crm_lead_sources ls on ls.id = cp.lead_source_id and ls.org_id = cp.org_id
       where cp.org_id = ${context.authz.user.orgId}${filters}${scope}
       order by p.display_name
       limit ${limit}
    `),
    db.execute<Record<string, unknown>>(sql`
      select cp.lifecycle_stage, count(*)::int as count
        from crm_account_profiles cp
        join parties p on p.id = cp.party_id and p.org_id = cp.org_id
       where cp.org_id = ${context.authz.user.orgId}${filters}${scope}
       group by cp.lifecycle_stage order by cp.lifecycle_stage
    `),
  ]);
  return {
    total: stages.rows.reduce((n, row) => n + Number(row.count ?? 0), 0),
    accounts: page.rows.map((row) => ({
      partyId: row.party_id,
      displayName: row.display_name,
      lifecycleStage: row.lifecycle_stage,
      statusName: row.status_name,
      isQualified: row.is_qualified,
      ownerName: row.owner_name,
      territoryName: row.territory_name,
      leadSourceName: row.lead_source_name,
      qualificationScore: row.qualification_score,
      nextActionAt: row.next_action_at,
      lastActivityAt: row.last_activity_at,
      isActive: row.is_active,
    })),
    byStage: stages.rows.map((row) => ({
      lifecycleStage: row.lifecycle_stage,
      count: Number(row.count ?? 0),
    })),
  };
}

/** One CRM account — same `loadCrmAccount` loader as the account drawer. */
export async function getApplicationCrmAccount(context: ApplicationContext, partyId: string) {
  assertApplicationPermission(context, "crm.accounts.read");
  if (!(await isFeatureEnabled(context.authz.user.orgId, "crm"))) crmOff();
  if (!isUuid(partyId)) throw invalidInput("party id must be a UUID");
  const loaded = await loadCrmAccount(partyId, context.authz.user.orgId, context.authz.allowedSubsidiaryIds);
  if (!loaded) throw notFound("crm account");
  const profile = loaded.profile as Record<string, unknown>;
  return {
    profile: {
      partyId: profile.party_id,
      lifecycleStage: profile.lifecycle_stage,
      statusName: profile.status_name,
      isQualified: profile.is_qualified,
      ownerName: profile.owner_name,
      territoryName: profile.territory_name,
      leadSourceName: profile.lead_source_name,
      industry: profile.industry,
      category: profile.category,
      annualRevenue: profile.annual_revenue == null ? null : money(profile.annual_revenue),
      employeeCount: profile.employee_count,
      qualificationScore: profile.qualification_score,
      nextActionAt: profile.next_action_at,
      lastActivityAt: profile.last_activity_at,
      qualifiedAt: profile.qualified_at,
      convertedAt: profile.converted_at,
      acquiredOn: profile.acquired_on,
      isActive: profile.is_active,
    },
    activities: (loaded.activities as Record<string, unknown>[]).map((activity) => ({
      activityId: activity.id,
      kind: activity.kind,
      status: activity.status,
      subject: activity.subject,
      priority: activity.priority,
      assignedName: activity.assigned_name,
      startsAt: activity.starts_at,
      dueAt: activity.due_at,
      completedAt: activity.completed_at,
    })),
    opportunities: (loaded.opportunities as Record<string, unknown>[]).map((row) => ({
      opportunityId: row.id,
      opportunityNumber: row.opportunity_number,
      title: row.title,
      statusName: row.status_name,
      isClosed: row.is_closed,
      isWon: row.is_won,
      forecastCategory: row.forecast_category,
      probability: row.probability,
      currency: row.currency,
      projectedAmount: money(row.projected_amount),
      weightedAmount: money(row.weighted_amount),
      expectedCloseDate: row.expected_close_date,
      ownerName: row.owner_name,
    })),
  };
}
