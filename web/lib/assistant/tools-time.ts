import "server-only";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { isFeatureEnabled } from "../features";
import { subsidiaryScopeAllows } from "../authz";
import { projectUnbilled } from "../project-costing";
import {
  loadProjectTimeEntryPage,
  ProjectTimeDetailError,
  type ProjectTimeDimension,
} from "../project-time-detail";
import {
  FieldTicketNotFoundError,
  loadFieldTicket,
  type TicketEntryRow,
  type TicketLineRow,
} from "../field-tickets";
import {
  loadWeek,
  pinTimesheetEmployee,
  weekStart,
} from "../../app/api/timesheets/_lib";
import type { AssistantToolDef, ToolResult } from "./types";
import { truncateText } from "./types";
import { dateInput, uuidInput, num, capList } from "./tools-shared";

/**
 * Time-tracking and field-ticket read/search tools for the agentic assistant.
 *
 * Timesheet reads carry the same `time.read` gate and `timeTracking` feature
 * flag as the timesheet routes, with the employee-subsidiary boundary the
 * routes enforce (an employee outside the caller's legal-entity scope reads
 * as missing; a null employee subsidiary fails closed for restricted
 * callers). Project-time reads mirror the project time-entries route
 * (`projects.read` + the Projects parent gate). Field-ticket reads mirror
 * the ticket routes (`time.read` + `fieldTickets`).
 *
 * Detail tools reuse the exact loaders the screens call (`loadWeek`,
 * `loadProjectTimeEntryPage`, `projectUnbilled`, `loadFieldTicket`).
 * Signature images are never returned — only signer names and timestamps.
 */

const TIME_FEATURE_ERROR = "timeTracking_feature_disabled";
const TICKET_FEATURE_ERROR = "fieldTickets_feature_disabled";

async function timeFeatureOff(orgId: string): Promise<boolean> {
  return !(await isFeatureEnabled(orgId, "timeTracking"));
}

async function ticketFeatureOff(orgId: string): Promise<boolean> {
  return !(await isFeatureEnabled(orgId, "fieldTickets"));
}

const getTimesheetWeekSchema = z.object({
  employeePartyId: uuidInput.describe("Employee party id"),
  week: dateInput.describe("Any date inside the week; the Sunday-start week containing it is read"),
});

const getTimesheetWeek: AssistantToolDef = {
  name: "get_timesheet_week",
  description:
    "One employee's timesheet week: entry grid with hours per day, line and week approval state, locks, and any rejection reason. Reading a week stamps its lifecycle header exactly like opening it on screen. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["time.read"] },
  feature: "timeTracking",
  inputSchema: getTimesheetWeekSchema,
  execute: async (raw, authz): Promise<ToolResult> => {
    if (await timeFeatureOff(authz.user.orgId)) return { ok: false, error: TIME_FEATURE_ERROR };
    const a = raw as z.infer<typeof getTimesheetWeekSchema>;
    // pinTimesheetEmployee is the route's boundary: an out-of-scope employee
    // reads as missing, exactly like the route.
    const owned = await pinTimesheetEmployee(authz.user.orgId, a.employeePartyId, authz.allowedSubsidiaryIds);
    if (!owned) return { ok: false, error: "employee_not_found" };
    let payload: Awaited<ReturnType<typeof loadWeek>>;
    try {
      payload = await loadWeek(authz.user.orgId, owned, weekStart(a.week), authz.allowedSubsidiaryIds);
    } catch (error) {
      if (error instanceof Error && /employee not found/i.test(error.message)) {
        return { ok: false, error: "employee_not_found" };
      }
      throw error;
    }
    const names = await resolveTimeNames(
      authz.user.orgId,
      payload.rows.map((r) => r.projectId),
      payload.rows.map((r) => r.itemId),
      payload.rows.map((r) => r.timeTypeId),
    );
    const rows = payload.rows.map((r) => ({
      projectId: r.projectId,
      projectName: r.projectId ? (names.projects.get(r.projectId) ?? null) : null,
      itemId: r.itemId,
      itemName: r.itemId ? (names.items.get(r.itemId) ?? null) : null,
      timeTypeId: r.timeTypeId,
      timeTypeName: r.timeTypeId ? (names.timeTypes.get(r.timeTypeId) ?? null) : null,
      departmentId: r.departmentId,
      isBillable: r.isBillable,
      memo: r.memo == null ? null : truncateText(r.memo, 200),
      hours: r.hours,
      totalHours: num(r.hours.reduce((sum, h) => sum + (h === "" ? 0 : Number(h)), 0)),
      entryStatuses: r.entryStatuses,
      immutable: r.immutable,
    }));
    const capped = capList(rows, 100);
    return {
      ok: true,
      data: {
        employeePartyId: payload.employeeId,
        week: payload.week,
        days: payload.days,
        status: payload.status,
        hasApproved: payload.hasApproved,
        lockReasons: payload.lockReasons,
        lockedCount: payload.lockedCount,
        rejectionReason: payload.rejectionReason,
        weekTotalHours: num(rows.reduce((sum, r) => sum + (r.totalHours as number), 0)),
        rows: capped.items,
        rowsTruncated: capped.truncated,
        href: "/timesheets",
      },
    };
  },
};

async function resolveTimeNames(
  orgId: string,
  projectIds: (string | null)[],
  itemIds: (string | null)[],
  timeTypeIds: (string | null)[],
): Promise<{ projects: Map<string, string>; items: Map<string, string>; timeTypes: Map<string, string> }> {
  const uniq = (ids: (string | null)[]) => [...new Set(ids.filter((id): id is string => !!id))].slice(0, 100);
  const [projects, items, timeTypes] = await Promise.all([
    db.execute<{ id: string; name: string }>(sql`
      select id, name from projects where org_id = ${orgId} and id = any(${`{${uniq(projectIds).join(",")}}`}::uuid[])`),
    db.execute<{ id: string; name: string }>(sql`
      select id, name from items where org_id = ${orgId} and id = any(${`{${uniq(itemIds).join(",")}}`}::uuid[])`),
    db.execute<{ id: string; name: string }>(sql`
      select id, name from time_types where org_id = ${orgId} and id = any(${`{${uniq(timeTypeIds).join(",")}}`}::uuid[])`),
  ]);
  return {
    projects: new Map(projects.rows.map((r) => [r.id, r.name])),
    items: new Map(items.rows.map((r) => [r.id, r.name])),
    timeTypes: new Map(timeTypes.rows.map((r) => [r.id, r.name])),
  };
}

const searchTimesheetsSchema = z.object({
  employeePartyId: uuidInput.optional().describe("Employee party id; omit for every employee"),
  status: z.enum(["draft", "submitted", "approved", "rejected", "empty"]).optional().describe("Week status; omit for every status"),
  weekFrom: dateInput.optional().describe("First week start (inclusive); omit for no lower bound"),
  weekTo: dateInput.optional().describe("Last week start (inclusive); omit for no upper bound"),
  limit: z.number().int().min(1).max(200).optional().describe("Page size (default 50); aggregates always cover ALL matches"),
});

const searchTimesheets: AssistantToolDef = {
  name: "search_timesheets",
  description:
    "Search timesheet weeks by employee, approval state, and week range: employee, week, status, total hours, and submitter/approver facts. Returns a capped page plus week counts and total hours over ALL matches. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["time.read"] },
  feature: "timeTracking",
  inputSchema: searchTimesheetsSchema,
  execute: async (raw, authz): Promise<ToolResult> => {
    if (await timeFeatureOff(authz.user.orgId)) return { ok: false, error: TIME_FEATURE_ERROR };
    const a = raw as z.infer<typeof searchTimesheetsSchema>;
    const limit = Math.min(a.limit ?? 50, 200);
    // Employee-subsidiary boundary, mirroring pinTimesheetEmployee: a null
    // employee subsidiary fails closed for restricted callers.
    const scope = authz.allowedSubsidiaryIds === null
      ? sql``
      : authz.allowedSubsidiaryIds.size > 0
        ? sql` and e.subsidiary_id = any(${`{${[...authz.allowedSubsidiaryIds].join(",")}}`}::uuid[])`
        : sql` and false`;
    const filters = sql.join(
      [
        a.employeePartyId ? sql` and w.employee_party_id = ${a.employeePartyId}` : sql``,
        a.status ? sql` and w.status = ${a.status}` : sql``,
        a.weekFrom ? sql` and w.week_start >= ${a.weekFrom}::date` : sql``,
        a.weekTo ? sql` and w.week_start <= ${a.weekTo}::date` : sql``,
      ],
      sql``,
    );
    const [page, totals, byStatus] = await Promise.all([
      db.execute<Record<string, unknown>>(sql`
        select w.id, w.employee_party_id, e.display_name as employee_name,
               w.week_start::text as week_start, w.status,
               coalesce(sum(te.hours), 0)::text as total_hours,
               count(te.id)::int as entry_count,
               w.submitted_at, w.approved_at, w.rejection_reason
          from timesheet_weeks w
          join parties e on e.id = w.employee_party_id and e.org_id = w.org_id
          left join time_entries te on te.org_id = w.org_id
            and te.employee_party_id = w.employee_party_id
            and te.worked_on >= w.week_start and te.worked_on < w.week_start + 7
         where w.org_id = ${authz.user.orgId}${filters}${scope}
         group by w.id, e.display_name
         order by w.week_start desc, e.display_name
         limit ${limit}
      `),
      db.execute<Record<string, unknown>>(sql`
        select count(distinct w.id)::int as weeks,
               coalesce(sum(te.hours), 0)::text as hours
          from timesheet_weeks w
          join parties e on e.id = w.employee_party_id and e.org_id = w.org_id
          left join time_entries te on te.org_id = w.org_id
            and te.employee_party_id = w.employee_party_id
            and te.worked_on >= w.week_start and te.worked_on < w.week_start + 7
         where w.org_id = ${authz.user.orgId}${filters}${scope}
      `),
      db.execute<Record<string, unknown>>(sql`
        select w.status, count(*)::int as count
          from timesheet_weeks w
          join parties e on e.id = w.employee_party_id and e.org_id = w.org_id
         where w.org_id = ${authz.user.orgId}${filters}${scope}
         group by w.status order by w.status
      `),
    ]);
    const total = totals.rows[0] ?? {};
    const capped = capList(
      page.rows.map((r) => ({
        weekId: r.id,
        employeePartyId: r.employee_party_id,
        employeeName: r.employee_name,
        weekStart: r.week_start,
        status: r.status,
        totalHours: num(r.total_hours),
        entryCount: Number(r.entry_count ?? 0),
        submittedAt: r.submitted_at,
        approvedAt: r.approved_at,
        rejectionReason: r.rejection_reason == null ? null : truncateText(String(r.rejection_reason), 200),
      })),
      limit,
    );
    return {
      ok: true,
      data: {
        returned: capped.items.length,
        totalWeeks: Number(total.weeks ?? 0),
        totalHours: num(total.hours ?? 0),
        truncated: capped.truncated,
        weeks: capped.items,
        byStatus: byStatus.rows.map((r) => ({ status: r.status, count: Number(r.count ?? 0) })),
        href: "/timesheets",
      },
    };
  },
};

const projectTimeSchema = z.object({
  projectId: uuidInput.describe("Project id"),
  dimension: z.enum(["employee", "item", "task"]).describe("Breakdown dimension, like the project time drawer"),
  dimensionId: uuidInput.optional().describe("One dimension value; omit for unassigned rows"),
  page: z.number().int().min(1).max(1000).optional().describe("Result page (default 1)"),
});

const projectTime: AssistantToolDef = {
  name: "project_time",
  description:
    "Approved project time broken down by employee, item, or task: summary hours with cost and bill values plus the entry page — the same detail the project time drawer shows. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["projects.read"] },
  feature: "projects",
  inputSchema: projectTimeSchema,
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "projects"))) {
      return { ok: false, error: "projects_feature_disabled" };
    }
    const a = raw as z.infer<typeof projectTimeSchema>;
    // loadProjectTimeEntryPage is the route's loader: a project outside the
    // caller's subsidiary scope reads as missing, exactly like the route.
    try {
      const page = await loadProjectTimeEntryPage({
        orgId: authz.user.orgId,
        projectId: a.projectId,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
        dimension: a.dimension as ProjectTimeDimension,
        dimensionId: a.dimensionId ?? null,
        page: a.page ?? 1,
      });
      return { ok: true, data: { ...page, href: "/projects" } };
    } catch (error) {
      if (error instanceof ProjectTimeDetailError) return { ok: false, error: "project_not_found" };
      throw error;
    }
  },
};

const unbilledTimeSchema = z.object({
  projectId: uuidInput.describe("Project id"),
  startDate: dateInput.optional().describe("Time worked on/after this date; omit for no lower bound"),
  cutoffDate: dateInput.optional().describe("Time worked on/before this date; omit for no upper bound"),
});

const unbilledTime: AssistantToolDef = {
  name: "unbilled_time",
  description:
    "Unbilled work for one project: uninvoiced billable time plus unbilled cost lines, with revenue, cost, hours, counts. Same figure as the billing cockpit. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["projects.read"] },
  feature: "projects",
  inputSchema: unbilledTimeSchema,
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "projects"))) {
      return { ok: false, error: "projects_feature_disabled" };
    }
    const a = raw as z.infer<typeof unbilledTimeSchema>;
    // The strict project boundary loadProjectTimeEntryPage applies: a
    // restricted caller only opens explicitly assigned projects, and an
    // unassigned project is invisible — a guessed UUID cannot reach the
    // unbilled figure.
    const scope = authz.allowedSubsidiaryIds === null
      ? sql``
      : authz.allowedSubsidiaryIds.size > 0
        ? sql` and subsidiary_id = any(${`{${[...authz.allowedSubsidiaryIds].join(",")}}`}::uuid[])`
        : sql` and false`;
    const pinned = await db.execute(sql`
      select 1 from projects where id = ${a.projectId} and org_id = ${authz.user.orgId}${scope}
    `);
    if (!pinned.rows[0]) return { ok: false, error: "project_not_found" };
    // projectUnbilled is the cockpit/billing-modal figure: approved billable
    // time plus billable cost lines, provenance-gated against re-billing.
    const unbilled = await projectUnbilled(authz.user.orgId, a.projectId, {
      startDate: a.startDate,
      cutoffDate: a.cutoffDate,
    });
    return {
      ok: true,
      data: {
        projectId: a.projectId,
        revenue: num(unbilled.revenue),
        cost: num(unbilled.cost),
        hours: num(unbilled.hours),
        timeEntryCount: unbilled.timeEntryCount,
        costLineCount: unbilled.costLineCount,
        href: "/projects",
      },
    };
  },
};

const listFieldTicketsSchema = z.object({
  status: z.enum(["draft", "pending_approval", "approved", "voided"]).optional().describe("Ticket status; omit for every status"),
  projectId: uuidInput.optional().describe("Project id; omit for every project"),
  limit: z.number().int().min(1).max(200).optional().describe("Page size (default 50); totals always cover ALL matches"),
});

const listFieldTickets: AssistantToolDef = {
  name: "list_field_tickets",
  description:
    "List field tickets: number, status, period window, customer, project, foreman, signature state, and total hours. Returns a capped page plus counts by status over ALL matches. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["time.read"] },
  feature: "fieldTickets",
  inputSchema: listFieldTicketsSchema,
  execute: async (raw, authz): Promise<ToolResult> => {
    if (await ticketFeatureOff(authz.user.orgId)) return { ok: false, error: TICKET_FEATURE_ERROR };
    const a = raw as z.infer<typeof listFieldTicketsSchema>;
    const limit = Math.min(a.limit ?? 50, 200);
    // Same narrowing as GET /api/field-tickets: a restricted caller sees only
    // their subsidiaries, and a null subsidiary fails closed.
    const scope = authz.allowedSubsidiaryIds === null
      ? sql``
      : authz.allowedSubsidiaryIds.size > 0
        ? sql` and d.subsidiary_id = any(${`{${[...authz.allowedSubsidiaryIds].join(",")}}`}::uuid[])`
        : sql` and false`;
    const filters = sql.join(
      [
        a.status ? sql` and d.status = ${a.status}` : sql``,
        a.projectId ? sql` and d.project_id = ${a.projectId}` : sql``,
      ],
      sql``,
    );
    const [page, byStatus] = await Promise.all([
      db.execute<Record<string, unknown>>(sql`
        select d.id, d.document_number, d.status, d.document_date::text as document_date, d.total,
               ft.period, ft.period_start::text as period_start,
               ft.period_end::text as period_end,
               (select max(signature.signed_at)
                  from field_ticket_signatures signature
                 where signature.org_id = d.org_id
                   and signature.field_ticket_id = d.id
                   and signature.role = 'customer') as signed_at,
               (select max(request.sent_at)
                  from field_ticket_signature_requests request
                 where request.org_id = d.org_id
                   and request.field_ticket_id = d.id
                   and request.sent_at is not null) as sent_at,
               cust.display_name as customer_name, p.name as project_name, p.code as project_code,
               fm.display_name as foreman_name,
               (select coalesce(sum(te.hours), 0) from time_entries te where te.field_ticket_id = d.id and te.org_id = d.org_id) as total_hours
          from documents d
          join field_tickets ft
            on ft.document_id = d.id and ft.org_id = d.org_id
          left join parties cust on cust.id = d.party_id and cust.org_id = d.org_id
          left join projects p on p.id = d.project_id and p.org_id = d.org_id
          left join parties fm on fm.id = ft.foreman_party_id and fm.org_id = ft.org_id
         where d.org_id = ${authz.user.orgId} and d.kind = 'field_ticket'${filters}${scope}
         order by d.document_date desc, d.created_at desc
         limit ${limit}
      `),
      db.execute<Record<string, unknown>>(sql`
        select d.status, count(*)::int as count
          from documents d
          join field_tickets ft on ft.document_id = d.id and ft.org_id = d.org_id
         where d.org_id = ${authz.user.orgId} and d.kind = 'field_ticket'${filters}${scope}
         group by d.status order by d.status
      `),
    ]);
    const capped = capList(
      page.rows.map((r) => ({
        ticketId: r.id,
        documentNumber: r.document_number,
        status: r.status,
        documentDate: r.document_date,
        total: num(r.total),
        period: r.period,
        periodStart: r.period_start,
        periodEnd: r.period_end,
        customerName: r.customer_name,
        projectName: r.project_name,
        projectCode: r.project_code,
        foremanName: r.foreman_name,
        customerSignedAt: r.signed_at,
        signatureSentAt: r.sent_at,
        totalHours: num(r.total_hours),
      })),
      limit,
    );
    return {
      ok: true,
      data: {
        returned: capped.items.length,
        total: byStatus.rows.reduce((n, r) => n + Number(r.count ?? 0), 0),
        truncated: capped.truncated,
        tickets: capped.items,
        byStatus: byStatus.rows.map((r) => ({ status: r.status, count: Number(r.count ?? 0) })),
        href: "/field-tickets",
      },
    };
  },
};

const getFieldTicket: AssistantToolDef = {
  name: "get_field_ticket",
  description:
    "One field ticket's detail: header facts, labor lines with rates and hours, signatures (names and timestamps only), and the materialized billing document — the same record the ticket screen shows. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["time.read"] },
  feature: "fieldTickets",
  inputSchema: z.object({ ticketId: uuidInput.describe("Ticket document id from list_field_tickets") }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (await ticketFeatureOff(authz.user.orgId)) return { ok: false, error: TICKET_FEATURE_ERROR };
    const a = raw as { ticketId: string };
    // The route's scope guard first: a missing ticket, or one whose document
    // sits outside the caller's subsidiary scope (an unassigned subsidiary
    // fails closed for restricted callers), reads as not-found.
    const owned = await db.execute<{ subsidiaryId: string | null }>(sql`
      select subsidiary_id as "subsidiaryId" from documents
       where id = ${a.ticketId} and org_id = ${authz.user.orgId} and kind = 'field_ticket'
    `);
    const subsidiaryId = owned.rows[0]?.subsidiaryId ?? null;
    if (!owned.rows[0] || !subsidiaryScopeAllows(authz.allowedSubsidiaryIds, subsidiaryId)) {
      return { ok: false, error: "field_ticket_not_found" };
    }
    // loadFieldTicket is the route's loader: it re-checks the feature flag
    // and its own subsidiary boundary as defense in depth.
    let loaded: Awaited<ReturnType<typeof loadFieldTicket>>;
    try {
      loaded = await loadFieldTicket(authz.user.orgId, a.ticketId, {
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      });
    } catch (error) {
      if (error instanceof FieldTicketNotFoundError) return { ok: false, error: "field_ticket_not_found" };
      throw error;
    }
    const ticket = loaded.fieldTicket;
    const labor = capList(
      (loaded.entries as TicketEntryRow[]).map((l) => ({
        employeeName: l.employee_name,
        itemName: l.item_name,
        timeTypeName: l.time_type_name,
        taskName: l.project_task_name,
        workedOn: l.worked_on,
        hours: num(l.hours),
        billRate: l.bill_rate == null ? null : num(l.bill_rate),
        status: l.status,
      })),
      100,
    );
    const materials = capList(
      (loaded.lines as TicketLineRow[]).map((l) => ({
        itemName: l.item_name,
        description: l.description == null ? null : truncateText(l.description, 200),
        quantity: num(l.quantity),
        unit: l.unit,
        unitPrice: num(l.unit_price),
        amount: num(l.amount),
        billAmount: l.bill_amount == null ? null : num(l.bill_amount),
      })),
      20,
    );
    // Signature pad images never leave this tool — only the signer identity
    // and timestamps the screen itself displays. The customer email the
    // screen shows is likewise withheld: it is never needed for reads.
    const signatures = ticket.signatures ?? {};
    return {
      ok: true,
      data: {
        ticket: {
          ticketId: a.ticketId,
          documentNumber: loaded.documentNumber,
          status: loaded.status,
          documentDate: loaded.documentDate,
          referenceNumber: loaded.referenceNumber,
          memo: loaded.memo == null ? null : truncateText(loaded.memo, 500),
          customerName: loaded.customerName,
          projectName: loaded.projectName,
          foremanName: loaded.foremanName,
          period: ticket.period,
          periodStart: ticket.periodStart,
          periodEnd: ticket.periodEnd,
          rejectionReason: ticket.rejectionReason ?? null,
          chargeDocumentId: ticket.chargeDocumentId ?? null,
          laborTotal: num(loaded.laborTotal),
          linesTotal: num(loaded.linesTotal),
          grandTotal: num(loaded.grandTotal),
        },
        labor: labor.items,
        laborTruncated: labor.truncated,
        materials: materials.items,
        materialsTruncated: materials.truncated,
        signatures: {
          foreman: signatures.foreman == null
            ? null
            : { name: signatures.foreman.name, at: signatures.foreman.at, comment: signatures.foreman.comment ?? null },
          customer: signatures.customer == null
            ? null
            : { name: signatures.customer.name, at: signatures.customer.at, comment: signatures.customer.comment ?? null },
        },
        href: `/field-tickets/${a.ticketId}`,
      },
    };
  },
};

export const TIME_TOOLS: AssistantToolDef[] = [
  getTimesheetWeek,
  searchTimesheets,
  projectTime,
  unbilledTime,
  listFieldTickets,
  getFieldTicket,
];
