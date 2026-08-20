import { sql } from "drizzle-orm";
import type { FlowSubjectProfile } from "@openbooks/forms-core";
import { db } from "../db.ts";
import type {
  FlowExecCtx,
  FlowSubjectAdapter,
  FlowSubjectContext,
} from "./types.ts";
import {
  BUILT_IN_ROLE_NAMES,
  EVENT_SOURCE_OPTIONS,
} from "./subject-profiles.ts";
import { releaseFlowApproval } from "./approval-release-hook.ts";

export const FIELD_TICKET_SUBJECT_KIND = "field_ticket";

const FIELD_TICKET_STATUSES = [
  { value: "draft", label: "Draft" },
  { value: "pending_approval", label: "Pending approval" },
  { value: "approved", label: "Approved" },
] as const;

/**
 * Field-ticket approval is optional and entirely tenant-authored. The profile
 * exposes the ticket, crew, project, and signature facts a tenant can use in
 * conditions; it does not embed an approver or approval threshold.
 */
export const fieldTicketSubjectProfile: FlowSubjectProfile = {
  subjectKind: FIELD_TICKET_SUBJECT_KIND,
  label: "Field ticket",
  triggers: ["on_submit"],
  actions: ["send_email", "notify", "lock_record", "unlock_record"],
  statuses: [...FIELD_TICKET_STATUSES],
  fields: [
    { key: "documentNumber", label: "Ticket number", type: "text" },
    { key: "status", label: "Status", type: "enum", options: [...FIELD_TICKET_STATUSES] },
    { key: "projectId", label: "Project", type: "text" },
    { key: "projectCode", label: "Project code", type: "text" },
    { key: "projectName", label: "Project name", type: "text" },
    { key: "customerId", label: "Customer", type: "text" },
    { key: "customerName", label: "Customer name", type: "text" },
    { key: "period", label: "Ticket period", type: "enum", options: [
      { value: "shift", label: "Shift" },
      { value: "daily", label: "Daily" },
      { value: "weekly", label: "Weekly" },
    ] },
    { key: "periodStart", label: "Period start", type: "date" },
    { key: "periodEnd", label: "Period end", type: "date" },
    { key: "totalHours", label: "Total hours", type: "number" },
    { key: "crewCount", label: "Crew members", type: "number" },
    { key: "lineCount", label: "Item lines", type: "number" },
    { key: "itemTotal", label: "Item total", type: "number" },
    { key: "customerSigned", label: "Customer signed", type: "bool" },
    { key: "foremanSigned", label: "Foreman signed", type: "bool" },
    { key: "createdBy", label: "Submitted by", type: "user" },
    {
      key: "event_source",
      label: "Event source",
      type: "enum",
      options: [...EVENT_SOURCE_OPTIONS],
    },
  ],
  roles: [...BUILT_IN_ROLE_NAMES],
};

type FieldTicketRow = {
  id: string;
  org_id: string;
  document_number: string;
  status: string;
  project_id: string | null;
  project_code: string | null;
  project_name: string | null;
  party_id: string | null;
  customer_name: string | null;
  subtotal: string;
  created_by: string | null;
  submitted_by: string | null;
  period: string | null;
  period_start: string | null;
  period_end: string | null;
  customer_signed: boolean;
  foreman_signed: boolean;
  total_hours: string;
  crew_count: number;
  line_count: number;
};

async function loadTicket(subjectId: string): Promise<FieldTicketRow | null> {
  const result = (await db.execute<FieldTicketRow>(sql`
    select d.id, d.org_id, d.document_number, d.status, d.project_id,
           p.code as project_code, p.name as project_name,
           d.party_id, customer.display_name as customer_name,
           d.subtotal::text, d.created_by,
           ft.submitted_by, ft.period,
           ft.period_start::text as period_start,
           ft.period_end::text as period_end,
           exists(select 1 from field_ticket_signatures signature
                   where signature.org_id = d.org_id
                     and signature.field_ticket_id = d.id
                     and signature.role = 'customer') as customer_signed,
           exists(select 1 from field_ticket_signatures signature
                   where signature.org_id = d.org_id
                     and signature.field_ticket_id = d.id
                     and signature.role = 'foreman') as foreman_signed,
           coalesce((select sum(te.hours) from time_entries te
                      where te.org_id = d.org_id and te.field_ticket_id = d.id), 0)::text as total_hours,
           (select count(distinct te.employee_party_id)::int from time_entries te
             where te.org_id = d.org_id and te.field_ticket_id = d.id) as crew_count,
           (select count(*)::int from document_lines dl
             where dl.org_id = d.org_id and dl.document_id = d.id) as line_count
      from documents d
      join field_tickets ft on ft.document_id = d.id and ft.org_id = d.org_id
      left join projects p on p.id = d.project_id and p.org_id = d.org_id
      left join parties customer on customer.id = d.party_id and customer.org_id = d.org_id
     where d.id = ${subjectId} and d.kind = 'field_ticket'
  `));
  return result.rows[0] ?? null;
}

export const fieldTicketsFlowAdapter: FlowSubjectAdapter = {
  subjectKind: FIELD_TICKET_SUBJECT_KIND,
  profile: fieldTicketSubjectProfile,
  writableFields: new Set<string>(),

  async loadContext(subjectId: string): Promise<FlowSubjectContext | null> {
    const ticket = await loadTicket(subjectId);
    if (!ticket) return null;
    const entries = (await db.execute<Record<string, unknown>>(sql`
      select te.employee_party_id as "employeePartyId",
             te.worked_on::text as "workedOn", te.hours::text,
             te.time_type_id as "timeTypeId", te.item_id as "itemId",
             te.project_task_id as "projectTaskId", te.is_billable as "isBillable"
        from time_entries te
       where te.org_id = ${ticket.org_id} and te.field_ticket_id = ${ticket.id}
       order by te.worked_on, te.employee_party_id, te.id
    `));
    return {
      values: {
        id: ticket.id,
        documentNumber: ticket.document_number,
        status: ticket.status,
        projectId: ticket.project_id,
        projectCode: ticket.project_code,
        projectName: ticket.project_name,
        customerId: ticket.party_id,
        customerName: ticket.customer_name,
        period: ticket.period,
        periodStart: ticket.period_start,
        periodEnd: ticket.period_end,
        totalHours: ticket.total_hours,
        crewCount: ticket.crew_count,
        lineCount: ticket.line_count,
        itemTotal: ticket.subtotal,
        customerSigned: ticket.customer_signed,
        foremanSigned: ticket.foreman_signed,
        createdBy: ticket.submitted_by ?? ticket.created_by,
      },
      rows: { timeEntries: entries.rows },
      submitterUserId: ticket.submitted_by ?? ticket.created_by,
    };
  },

  label(subjectId: string, values: Record<string, unknown>): string {
    const number = String(values.documentNumber ?? subjectId);
    const project = values.projectName ? ` — ${String(values.projectName)}` : "";
    return `Field ticket ${number}${project}`;
  },

  deepLink(subjectId: string): string {
    return `/field-tickets?ticket=${subjectId}`;
  },

  async getStatus(subjectId: string): Promise<string | null> {
    return (await loadTicket(subjectId))?.status ?? null;
  },

  async changeStatus(): Promise<void> {
    throw new Error(
      "field-ticket lifecycle is released by the approval engine, not a flow action",
    );
  },

  async releaseApproval(subjectId, outcome, ctx, detail): Promise<void> {
    await releaseFlowApproval({
      subjectKind: FIELD_TICKET_SUBJECT_KIND,
      subjectId,
      outcome,
      comment: detail?.comment,
      ctx,
    });
  },

  async setField(): Promise<void> {
    throw new Error(
      "field-ticket fields are not writable by flows; edit the draft ticket",
    );
  },
};
