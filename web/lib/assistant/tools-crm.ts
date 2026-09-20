import "server-only";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import {
  addCalendarDays,
  addCalendarMonthsStart,
  businessToday,
  isIsoCalendarDate,
  startOfMonth,
} from "@openbooks/engine/src/platform/business-date.ts";
import { isFeatureEnabled } from "../features";
import {
  calculateForecast,
  loadActivity,
  loadCrmAccount,
  loadOpportunity,
} from "../crm";
import {
  crmActivityScope,
  crmOpportunityScope,
  crmSharedScope,
} from "../crm-scope";
import { type AssistantToolDef, type ToolResult, truncateText } from "./types";
import { dateInput, uuidInput, num, capList } from "./tools-shared";

/**
 * CRM read/search tools for the agentic assistant. Every tool is gated with
 * the same permission key its screen or JSON route enforces, hidden while the
 * `crm` switchboard flag is off, and scoped to the caller's subsidiary
 * allowlist with the same scope helpers the CRM loaders use
 * (`crmOpportunityScope`, `crmSharedScope`, `crmActivityScope`).
 *
 * Detail tools reuse the exact loaders the drawers and routes call
 * (`loadOpportunity`, `loadCrmAccount`, `loadActivity`, `calculateForecast`);
 * list tools carry the same scope fragment the entity-list sources apply.
 * Money stays canonical decimal strings on the wire and is presented with the
 * shared 2-dp `num` projection, like the payroll tools.
 */

const FEATURE_ERROR = "crm_feature_disabled";

async function featureOff(orgId: string): Promise<boolean> {
  return !(await isFeatureEnabled(orgId, "crm"));
}

const OPPORTUNITY_ROW = sql`
  select o.id, o.opportunity_number, o.title, o.expected_close_date::text as expected_close_date,
         o.forecast_category, o.probability, o.currency,
         o.projected_amount, o.weighted_amount, o.is_active,
         s.name as status_name, s.is_closed, s.is_won,
         p.display_name as party_name, u.name as owner_name
    from crm_opportunities o
    join crm_opportunity_statuses s on s.id = o.status_id and s.org_id = o.org_id
    left join parties p on p.id = o.party_id and p.org_id = o.org_id
    left join users u on u.id = o.owner_user_id`;

const searchOpportunitiesSchema = z.object({
  query: z.string().max(100).optional().describe("Substring over title, opportunity number, or customer name"),
  statusId: uuidInput.optional().describe("One opportunity status id; omit for every status"),
  ownerUserId: uuidInput.optional().describe("Owning user id; omit for every owner"),
  salesTeamId: uuidInput.optional().describe("Sales team id; omit for every team"),
  openOnly: z.boolean().optional().describe("True = open pipeline only (default false = open and closed)"),
  limit: z.number().int().min(1).max(200).optional().describe("Page size (default 50); aggregates always cover ALL matches"),
});

type OpportunityFilters = {
  query?: string;
  statusId?: string;
  ownerUserId?: string;
  salesTeamId?: string;
  openOnly?: boolean;
};

function opportunityFilters(a: OpportunityFilters) {
  const like = a.query ? `%${a.query}%` : null;
  return sql.join(
    [
      like
        ? sql` and (o.title ilike ${like} or o.opportunity_number ilike ${like} or p.display_name ilike ${like})`
        : sql``,
      a.statusId ? sql` and o.status_id = ${a.statusId}` : sql``,
      a.ownerUserId ? sql` and o.owner_user_id = ${a.ownerUserId}` : sql``,
      a.salesTeamId ? sql` and o.sales_team_id = ${a.salesTeamId}` : sql``,
      a.openOnly ? sql` and not s.is_closed` : sql``,
    ],
    sql``,
  );
}

function opportunityRow(r: Record<string, unknown>) {
  return {
    id: r.id,
    opportunityNumber: r.opportunity_number,
    title: r.title,
    customerName: r.party_name,
    ownerName: r.owner_name,
    statusName: r.status_name,
    isClosed: r.is_closed,
    isWon: r.is_won,
    forecastCategory: r.forecast_category,
    probability: r.probability,
    currency: r.currency,
    projectedAmount: num(r.projected_amount),
    weightedAmount: num(r.weighted_amount),
    expectedCloseDate: r.expected_close_date,
    isActive: r.is_active,
  };
}

const searchOpportunities: AssistantToolDef = {
  name: "search_opportunities",
  description:
    "Search sales opportunities (open and closed): number, title, customer, owner, stage, probability, projected/weighted amounts. Capped page plus totals and per-stage breakdown. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["crm.opportunities.read"] },
  feature: "crm",
  inputSchema: searchOpportunitiesSchema,
  execute: async (raw, authz): Promise<ToolResult> => {
    if (await featureOff(authz.user.orgId)) return { ok: false, error: FEATURE_ERROR };
    const a = raw as z.infer<typeof searchOpportunitiesSchema>;
    const limit = Math.min(a.limit ?? 50, 200);
    const filters = opportunityFilters(a);
    const scope = crmOpportunityScope(authz.allowedSubsidiaryIds);
    const [page, totals, stages] = await Promise.all([
      db.execute<Record<string, unknown>>(sql`
        ${OPPORTUNITY_ROW}
         where o.org_id = ${authz.user.orgId}${filters}${scope}
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
         where o.org_id = ${authz.user.orgId}${filters}${scope}
         group by o.currency order by o.currency
      `),
      db.execute<Record<string, unknown>>(sql`
        select s.name as status_name, s.is_closed, s.is_won, o.currency,
               count(*)::int as count,
               coalesce(sum(o.projected_amount), 0)::text as projected,
               coalesce(sum(o.weighted_amount), 0)::text as weighted
          from crm_opportunities o
          join crm_opportunity_statuses s on s.id = o.status_id and s.org_id = o.org_id
          left join parties p on p.id = o.party_id and p.org_id = o.org_id
         where o.org_id = ${authz.user.orgId}${filters}${scope}
         group by s.name, s.is_closed, s.is_won, o.currency
         order by s.is_closed, s.name, o.currency
      `),
    ]);
    const capped = capList(page.rows.map(opportunityRow));
    return {
      ok: true,
      data: {
        returned: capped.items.length,
        total: totals.rows.reduce((n, r) => n + Number(r.count ?? 0), 0),
        truncated: capped.truncated,
        opportunities: capped.items,
        totalsByCurrency: totals.rows.map((r) => ({
          currency: r.currency,
          count: Number(r.count ?? 0),
          projectedAmount: num(r.projected),
          weightedAmount: num(r.weighted),
        })),
        byStage: stages.rows.map((r) => ({
          statusName: r.status_name,
          isClosed: r.is_closed,
          isWon: r.is_won,
          currency: r.currency,
          count: Number(r.count ?? 0),
          projectedAmount: num(r.projected),
          weightedAmount: num(r.weighted),
        })),
        href: "/crm/opportunities",
      },
    };
  },
};

const getOpportunity: AssistantToolDef = {
  name: "get_opportunity",
  description:
    "One opportunity's full detail — header facts, stage, probability-weighted amounts, lines, sales team, linked documents, related activities, and stage history — the same record the opportunity drawer shows. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["crm.opportunities.read"] },
  feature: "crm",
  inputSchema: z.object({ opportunityId: uuidInput.describe("Opportunity id from search_opportunities") }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (await featureOff(authz.user.orgId)) return { ok: false, error: FEATURE_ERROR };
    const a = raw as { opportunityId: string };
    // loadOpportunity is the drawer/route loader: a record outside the
    // caller's subsidiary scope reads as missing, exactly like the route.
    const loaded = await loadOpportunity(a.opportunityId, authz.user.orgId, authz.allowedSubsidiaryIds);
    if (!loaded) return { ok: false, error: "opportunity_not_found" };
    const head = loaded.opportunity as Record<string, unknown>;
    const lines = capList(
      (loaded.lines as Record<string, unknown>[]).map((l) => ({
        lineNumber: l.line_number,
        description: truncateText(l.description as string | null, 200),
        quantity: num(l.quantity),
        unit: l.unit,
        unitPrice: num(l.unit_price),
        amount: num(l.amount),
        expectedAmount: num(l.expected_amount),
      })),
      50,
    );
    const team = capList(
      (loaded.team as Record<string, unknown>[]).map((m) => ({
        userName: m.user_name,
        userEmail: m.user_email,
        isPrimary: m.is_primary,
        role: m.role,
      })),
      20,
    );
    const documents = capList(
      (loaded.documents as Record<string, unknown>[]).map((d) => ({
        documentId: d.id,
        kind: d.kind,
        documentNumber: d.document_number,
        documentDate: d.document_date,
        status: d.status,
        currency: d.currency,
        total: num(d.total),
      })),
      20,
    );
    const activities = capList(
      (loaded.activities as Record<string, unknown>[]).map((x) => ({
        activityId: x.id,
        kind: x.kind,
        status: x.status,
        subject: truncateText(x.subject as string | null, 160),
        startsAt: x.starts_at,
        dueAt: x.due_at,
        completedAt: x.completed_at,
      })),
      20,
    );
    const history = capList(
      (loaded.history as Record<string, unknown>[]).map((h) => ({
        fromStatus: h.from_status_name,
        toStatus: h.to_status_name,
        actorName: h.actor_name,
        occurredAt: h.occurred_at,
        note: truncateText(h.note as string | null, 200),
      })),
      20,
    );
    return {
      ok: true,
      data: {
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
          projectedAmount: num(head.projected_amount),
          weightedAmount: num(head.weighted_amount),
          rangeLow: head.range_low == null ? null : num(head.range_low),
          rangeHigh: head.range_high == null ? null : num(head.range_high),
          expectedCloseDate: head.expected_close_date,
          nextStep: truncateText(head.next_step as string | null, 300),
          description: truncateText(head.description as string | null, 500),
          isActive: head.is_active,
        },
        lines: lines.items,
        linesTruncated: lines.truncated,
        team: team.items,
        teamTruncated: team.truncated,
        documents: documents.items,
        documentsTruncated: documents.truncated,
        activities: activities.items,
        activitiesTruncated: activities.truncated,
        history: history.items,
        historyTruncated: history.truncated,
        href: `/crm/opportunities?opportunity=${a.opportunityId}`,
      },
    };
  },
};

const searchCrmAccountsSchema = z.object({
  query: z.string().max(100).optional().describe("Substring over the party display name"),
  stage: z.enum(["lead", "prospect", "customer"]).optional().describe("Lifecycle stage; omit for every stage"),
  ownerUserId: uuidInput.optional().describe("Owning user id; omit for every owner"),
  limit: z.number().int().min(1).max(200).optional().describe("Page size (default 50); aggregates always cover ALL matches"),
});

const searchCrmAccounts: AssistantToolDef = {
  name: "search_crm_accounts",
  description:
    "Search CRM accounts across the lead → prospect → customer lifecycle: party, stage, status, owner, territory, qualification score, and last activity. Returns a capped page plus counts by stage over ALL matches. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["crm.accounts.read"] },
  feature: "crm",
  inputSchema: searchCrmAccountsSchema,
  execute: async (raw, authz): Promise<ToolResult> => {
    if (await featureOff(authz.user.orgId)) return { ok: false, error: FEATURE_ERROR };
    const a = raw as z.infer<typeof searchCrmAccountsSchema>;
    const limit = Math.min(a.limit ?? 50, 200);
    const like = a.query ? `%${a.query}%` : null;
    const filters = sql.join(
      [
        like ? sql` and p.display_name ilike ${like}` : sql``,
        a.stage ? sql` and cp.lifecycle_stage = ${a.stage}` : sql``,
        a.ownerUserId ? sql` and cp.owner_user_id = ${a.ownerUserId}` : sql``,
      ],
      sql``,
    );
    const scope = crmSharedScope(sql`p.subsidiary_id`, authz.allowedSubsidiaryIds);
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
         where cp.org_id = ${authz.user.orgId}${filters}${scope}
         order by p.display_name
         limit ${limit}
      `),
      db.execute<Record<string, unknown>>(sql`
        select cp.lifecycle_stage, count(*)::int as count
          from crm_account_profiles cp
          join parties p on p.id = cp.party_id and p.org_id = cp.org_id
         where cp.org_id = ${authz.user.orgId}${filters}${scope}
         group by cp.lifecycle_stage order by cp.lifecycle_stage
      `),
    ]);
    const capped = capList(
      page.rows.map((r) => ({
        partyId: r.party_id,
        displayName: r.display_name,
        lifecycleStage: r.lifecycle_stage,
        statusName: r.status_name,
        isQualified: r.is_qualified,
        ownerName: r.owner_name,
        territoryName: r.territory_name,
        leadSourceName: r.lead_source_name,
        qualificationScore: r.qualification_score,
        nextActionAt: r.next_action_at,
        lastActivityAt: r.last_activity_at,
        isActive: r.is_active,
      })),
    );
    // One account list, segmented by lifecycle stage: the stage rides in as
    // the `status` chip the list already reads, not as a separate route.
    const stageHref = a.stage ? `/entities/customers?status=${a.stage}` : "/entities/customers?status=all";
    return {
      ok: true,
      data: {
        returned: capped.items.length,
        total: stages.rows.reduce((n, r) => n + Number(r.count ?? 0), 0),
        truncated: capped.truncated,
        accounts: capped.items,
        byStage: stages.rows.map((r) => ({ lifecycleStage: r.lifecycle_stage, count: Number(r.count ?? 0) })),
        href: stageHref,
      },
    };
  },
};

const getCrmAccount: AssistantToolDef = {
  name: "get_crm_account",
  description:
    "One CRM account's full detail — profile facts, recent activities, open opportunities, stage and ownership history — the same record the account drawer shows. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["crm.accounts.read"] },
  feature: "crm",
  inputSchema: z.object({ partyId: uuidInput.describe("Party id from search_crm_accounts") }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (await featureOff(authz.user.orgId)) return { ok: false, error: FEATURE_ERROR };
    const a = raw as { partyId: string };
    // loadCrmAccount is the drawer/route loader: an out-of-scope profile
    // reads as missing, exactly like the route.
    const loaded = await loadCrmAccount(a.partyId, authz.user.orgId, authz.allowedSubsidiaryIds);
    if (!loaded) return { ok: false, error: "crm_account_not_found" };
    const profile = loaded.profile as Record<string, unknown>;
    const activities = capList(
      (loaded.activities as Record<string, unknown>[]).map((x) => ({
        activityId: x.id,
        kind: x.kind,
        status: x.status,
        subject: truncateText(x.subject as string | null, 160),
        priority: x.priority,
        assignedName: x.assigned_name,
        startsAt: x.starts_at,
        dueAt: x.due_at,
        completedAt: x.completed_at,
      })),
      20,
    );
    const opportunities = capList(
      (loaded.opportunities as Record<string, unknown>[]).map((o) => ({
        opportunityId: o.id,
        opportunityNumber: o.opportunity_number,
        title: o.title,
        statusName: o.status_name,
        isClosed: o.is_closed,
        isWon: o.is_won,
        forecastCategory: o.forecast_category,
        probability: o.probability,
        currency: o.currency,
        projectedAmount: num(o.projected_amount),
        weightedAmount: num(o.weighted_amount),
        expectedCloseDate: o.expected_close_date,
        ownerName: o.owner_name,
      })),
      20,
    );
    return {
      ok: true,
      data: {
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
          annualRevenue: profile.annual_revenue == null ? null : num(profile.annual_revenue),
          employeeCount: profile.employee_count,
          qualificationScore: profile.qualification_score,
          nextActionAt: profile.next_action_at,
          lastActivityAt: profile.last_activity_at,
          qualifiedAt: profile.qualified_at,
          convertedAt: profile.converted_at,
          acquiredOn: profile.acquired_on,
          isActive: profile.is_active,
        },
        activities: activities.items,
        activitiesTruncated: activities.truncated,
        opportunities: opportunities.items,
        opportunitiesTruncated: opportunities.truncated,
        stageEvents: capList(loaded.stageEvents as Record<string, unknown>[], 20).items,
        assignments: capList(loaded.assignments as Record<string, unknown>[], 20).items,
        href: `/entities/customers?party=${a.partyId}&partyTab=relationship`,
      },
    };
  },
};

const searchCrmActivitiesSchema = z.object({
  query: z.string().max(100).optional().describe("Substring over the activity subject"),
  kind: z.string().max(40).optional().describe("Activity kind; omit for every kind"),
  status: z.string().max(40).optional().describe("Activity status; omit for every status"),
  assignedUserId: uuidInput.optional().describe("Assigned user id; omit for every assignee"),
  overdueOnly: z.boolean().optional().describe("True = due before today and not completed"),
  limit: z.number().int().min(1).max(200).optional().describe("Page size (default 50); aggregates always cover ALL matches"),
});

const searchCrmActivities: AssistantToolDef = {
  name: "search_crm_activities",
  description:
    "Search CRM activities (tasks, calls, meetings, follow-ups): subject, kind, status, owner, assignee, due and completion dates. Returns a capped page plus counts by status over ALL matches. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["crm.activities.read"] },
  feature: "crm",
  inputSchema: searchCrmActivitiesSchema,
  execute: async (raw, authz): Promise<ToolResult> => {
    if (await featureOff(authz.user.orgId)) return { ok: false, error: FEATURE_ERROR };
    const a = raw as z.infer<typeof searchCrmActivitiesSchema>;
    const limit = Math.min(a.limit ?? 50, 200);
    const like = a.query ? `%${a.query}%` : null;
    // crmActivityScope pins the `a` alias: activities linked to a record the
    // caller cannot see stay hidden, like the activities list.
    const filters = sql.join(
      [
        like ? sql` and a.subject ilike ${like}` : sql``,
        a.kind ? sql` and a.kind = ${a.kind}` : sql``,
        a.status ? sql` and a.status = ${a.status}` : sql``,
        a.assignedUserId ? sql` and a.assigned_user_id = ${a.assignedUserId}` : sql``,
        a.overdueOnly ? sql` and a.due_at < now() and a.completed_at is null` : sql``,
      ],
      sql``,
    );
    const scope = crmActivityScope(authz.allowedSubsidiaryIds);
    const [page, statuses] = await Promise.all([
      db.execute<Record<string, unknown>>(sql`
        select a.id, a.kind, a.status, a.subject, a.priority,
               a.starts_at, a.due_at, a.completed_at,
               ou.name as owner_name, au.name as assigned_name
          from crm_activities a
          left join users ou on ou.id = a.owner_user_id
          left join users au on au.id = a.assigned_user_id
         where a.org_id = ${authz.user.orgId}${filters}${scope}
         order by coalesce(a.starts_at, a.due_at, a.created_at) desc
         limit ${limit}
      `),
      db.execute<Record<string, unknown>>(sql`
        select a.status, count(*)::int as count
          from crm_activities a
         where a.org_id = ${authz.user.orgId}${filters}${scope}
         group by a.status order by a.status
      `),
    ]);
    const capped = capList(
      page.rows.map((r) => ({
        activityId: r.id,
        kind: r.kind,
        status: r.status,
        subject: truncateText(r.subject as string | null, 160),
        priority: r.priority,
        ownerName: r.owner_name,
        assignedName: r.assigned_name,
        startsAt: r.starts_at,
        dueAt: r.due_at,
        completedAt: r.completed_at,
      })),
    );
    return {
      ok: true,
      data: {
        returned: capped.items.length,
        total: statuses.rows.reduce((n, r) => n + Number(r.count ?? 0), 0),
        truncated: capped.truncated,
        activities: capped.items,
        byStatus: statuses.rows.map((r) => ({ status: r.status, count: Number(r.count ?? 0) })),
        href: "/crm/activities",
      },
    };
  },
};

const getCrmActivity: AssistantToolDef = {
  name: "get_crm_activity",
  description:
    "One CRM activity's full detail — header facts, the records it is linked to, and its participants — the same record the activity drawer shows. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["crm.activities.read"] },
  feature: "crm",
  inputSchema: z.object({ activityId: uuidInput.describe("Activity id from search_crm_activities") }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (await featureOff(authz.user.orgId)) return { ok: false, error: FEATURE_ERROR };
    const a = raw as { activityId: string };
    // loadActivity is the drawer/route loader: a hidden-linked activity
    // reads as missing, exactly like the route.
    const loaded = await loadActivity(a.activityId, authz.user.orgId, authz.allowedSubsidiaryIds);
    if (!loaded) return { ok: false, error: "crm_activity_not_found" };
    const head = loaded.activity as Record<string, unknown>;
    return {
      ok: true,
      data: {
        activity: {
          id: head.id,
          kind: head.kind,
          status: head.status,
          subject: head.subject,
          body: truncateText(head.body as string | null, 1000),
          priority: head.priority,
          ownerName: head.owner_name,
          assignedName: head.assigned_name,
          startsAt: head.starts_at,
          endsAt: head.ends_at,
          dueAt: head.due_at,
          completedAt: head.completed_at,
          durationMinutes: head.duration_minutes,
          isPrivate: head.is_private,
        },
        links: capList(loaded.links as Record<string, unknown>[], 20).items,
        participants: capList(loaded.participants as Record<string, unknown>[], 20).items,
        href: "/crm/activities",
      },
    };
  },
};

const crmForecastSchema = z.object({
  periodStart: dateInput.optional().describe("Window start; defaults to the first of the current month"),
  periodEnd: dateInput.optional().describe("Window end; defaults to the end of the quarter starting this month"),
  ownerUserId: uuidInput.optional().describe("Owning user id; omit for every owner"),
  salesTeamId: uuidInput.optional().describe("Sales team id; omit for every team"),
});

const crmForecast: AssistantToolDef = {
  name: "crm_forecast",
  description:
    "Sales forecast for a close-date window: pipeline, weighted, worst/likely/upside, closed revenue per currency, quotas, saved snapshots (if permitted). Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["crm.forecasts.read"] },
  feature: "crm",
  inputSchema: crmForecastSchema,
  execute: async (raw, authz): Promise<ToolResult> => {
    if (await featureOff(authz.user.orgId)) return { ok: false, error: FEATURE_ERROR };
    const a = raw as z.infer<typeof crmForecastSchema>;
    // Same window defaults as GET /api/crm/forecasts: this month plus two.
    const today = await businessToday(authz.user.orgId);
    const periodStart = a.periodStart ?? startOfMonth(today);
    const periodEnd = a.periodEnd ?? addCalendarDays(addCalendarMonthsStart(startOfMonth(today), 3), -1);
    if (!isIsoCalendarDate(periodStart) || !isIsoCalendarDate(periodEnd) || periodEnd < periodStart) {
      return { ok: false, error: "invalid_forecast_period" };
    }
    // calculateForecast is the route's rollup: exact NUMERIC arithmetic with
    // the same team/pipeline population boundary and subsidiary scope.
    const [forecast, quotas, snapshots] = await Promise.all([
      calculateForecast({
        orgId: authz.user.orgId,
        periodStart,
        periodEnd,
        ownerUserId: a.ownerUserId ?? null,
        salesTeamId: a.salesTeamId ?? null,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      }),
      db.execute<Record<string, unknown>>(sql`
        select q.*, u.name as owner_name, t.name as sales_team_name from crm_sales_quotas q
        left join users u on u.id = q.owner_user_id left join crm_sales_teams t on t.id = q.sales_team_id and t.org_id = q.org_id
        where q.org_id = ${authz.user.orgId} and q.period_start <= ${periodEnd}::date and q.period_end >= ${periodStart}::date
          ${a.ownerUserId ? sql`and q.owner_user_id = ${a.ownerUserId}` : sql``}
          ${a.salesTeamId ? sql`and q.sales_team_id = ${a.salesTeamId}` : sql``}
        order by q.period_start, coalesce(u.name, t.name)`),
      // Stored snapshots aggregate the whole org without entity lineage, so
      // restricted callers never see them — the same boundary as the route.
      authz.allowedSubsidiaryIds === null
        ? db.execute<Record<string, unknown>>(sql`
          select s.*, u.name as owner_name, t.name as sales_team_name from crm_forecast_snapshots s
          left join users u on u.id = s.owner_user_id left join crm_sales_teams t on t.id = s.sales_team_id and t.org_id = s.org_id
          where s.org_id = ${authz.user.orgId} and s.period_start = ${periodStart}::date and s.period_end = ${periodEnd}::date
            ${a.ownerUserId ? sql`and s.owner_user_id = ${a.ownerUserId}` : sql``}
            ${a.salesTeamId ? sql`and s.sales_team_id = ${a.salesTeamId}` : sql``}
          order by s.as_of desc limit 50`)
        : Promise.resolve({ rows: [] as Record<string, unknown>[] }),
    ]);
    return {
      ok: true,
      data: {
        periodStart,
        periodEnd,
        forecast: forecast.map((row) => ({
          currency: row.currency,
          pipelineAmount: num(row.pipeline_amount),
          weightedAmount: num(row.weighted_amount),
          worstCaseAmount: num(row.worst_case_amount),
          mostLikelyAmount: num(row.most_likely_amount),
          upsideAmount: num(row.upside_amount),
          closedAmount: num(row.closed_amount),
        })),
        quotas: capList(quotas.rows, 50).items,
        snapshots: capList(snapshots.rows, 10).items,
        href: "/crm/forecasts",
      },
    };
  },
};

export const CRM_TOOLS: AssistantToolDef[] = [
  searchOpportunities,
  getOpportunity,
  searchCrmAccounts,
  getCrmAccount,
  searchCrmActivities,
  getCrmActivity,
  crmForecast,
];
