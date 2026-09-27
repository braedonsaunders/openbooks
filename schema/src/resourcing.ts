import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, money, orgRef } from "./helpers";

export const RESOURCING_REQUEST_SUBJECT_KIND = "resourcing_request";

export const RES_ASSIGNMENT_BOOKING_VALUES = ["soft", "hard"] as const;
export const RES_ASSIGNMENT_STATE_VALUES = ["active", "released"] as const;
export const RES_ASSIGNMENT_SOURCE_VALUES = ["manual", "request", "pipeline"] as const;
export const RES_REQUEST_STATUS_VALUES = ["draft", "submitted", "approved", "rejected", "cancelled"] as const;
export const RES_RETAINER_KIND_VALUES = ["hours", "fees"] as const;
export const RES_RETAINER_STATE_VALUES = ["draft", "active", "exhausted", "expired", "closed"] as const;
export const RES_RETAINER_DRAWDOWN_STATE_VALUES = ["draft", "posted"] as const;

/** One planned project booking for a named employee or a generic role. */
export const resAssignments = pgTable(
  "res_assignments",
  {
    id: id(),
    orgId: orgRef(),
    projectId: uuid("project_id").notNull(),
    employeePartyId: uuid("employee_party_id"),
    jobTitle: text("job_title"),
    weekStart: date("week_start").notNull(),
    plannedHours: money("planned_hours").notNull(),
    isBillable: boolean("is_billable").notNull().default(true),
    billItemId: uuid("bill_item_id"),
    projectTaskId: uuid("project_task_id"),
    booking: text("booking", { enum: RES_ASSIGNMENT_BOOKING_VALUES }).notNull().default("hard"),
    state: text("state", { enum: RES_ASSIGNMENT_STATE_VALUES }).notNull().default("active"),
    source: text("source", { enum: RES_ASSIGNMENT_SOURCE_VALUES }).notNull().default("manual"),
    requestId: uuid("request_id"),
    custom: jsonb("custom").notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("res_assignments_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("res_assignments_booking_key").on(
      t.orgId,
      t.projectId,
      t.weekStart,
      sql`coalesce(${t.employeePartyId}::text, lower(${t.jobTitle}))`,
    ),
    index("res_assignments_employee_week").on(t.orgId, t.employeePartyId, t.weekStart),
    index("res_assignments_week").on(t.orgId, t.weekStart),
    check(
      "res_assignments_subject",
      sql`num_nonnulls(${t.employeePartyId}, ${t.jobTitle}) = 1`,
    ),
    check(
      "res_assignments_job_title_nonblank",
      sql`${t.jobTitle} is null or length(btrim(${t.jobTitle})) > 0`,
    ),
    check("res_assignments_week_start_sunday", sql`extract(dow from ${t.weekStart}) = 0`),
    check(
      "res_assignments_planned_hours_range",
      sql`${t.plannedHours} > 0 and ${t.plannedHours} <= 168`,
    ),
  ],
);

/** A Flows-backed request for a named person or a generic role. */
export const resRequests = pgTable(
  "res_requests",
  {
    id: id(),
    orgId: orgRef(),
    projectId: uuid("project_id").notNull(),
    employeePartyId: uuid("employee_party_id"),
    jobTitle: text("job_title"),
    firstWeek: date("first_week").notNull(),
    lastWeek: date("last_week").notNull(),
    hoursPerWeek: money("hours_per_week").notNull(),
    isBillable: boolean("is_billable").notNull().default(true),
    billItemId: uuid("bill_item_id"),
    reason: text("reason"),
    status: text("status", { enum: RES_REQUEST_STATUS_VALUES }).notNull().default("draft"),
    decidedBy: uuid("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionComment: text("decision_comment"),
    flowInstanceId: uuid("flow_instance_id"),
    custom: jsonb("custom").notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("res_requests_org_id_id_unique").on(t.orgId, t.id),
    index("res_requests_status").on(t.orgId, t.status),
    check("res_requests_subject", sql`num_nonnulls(${t.employeePartyId}, ${t.jobTitle}) = 1`),
    check(
      "res_requests_job_title_nonblank",
      sql`${t.jobTitle} is null or length(btrim(${t.jobTitle})) > 0`,
    ),
    check("res_requests_first_week_sunday", sql`extract(dow from ${t.firstWeek}) = 0`),
    check("res_requests_last_week_sunday", sql`extract(dow from ${t.lastWeek}) = 0`),
    check("res_requests_week_order", sql`${t.firstWeek} <= ${t.lastWeek}`),
    check(
      "res_requests_hours_per_week_range",
      sql`${t.hoursPerWeek} > 0 and ${t.hoursPerWeek} <= 168`,
    ),
  ],
);

/** A department's manual role demand over a Sunday-based planning range. */
export const resDemandLines = pgTable(
  "res_demand_lines",
  {
    id: id(),
    orgId: orgRef(),
    departmentId: uuid("department_id").notNull(),
    jobTitle: text("job_title").notNull(),
    firstWeek: date("first_week").notNull(),
    lastWeek: date("last_week").notNull(),
    hoursPerWeek: money("hours_per_week").notNull(),
    note: text("note"),
    opportunityId: uuid("opportunity_id"),
    custom: jsonb("custom").notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("res_demand_lines_org_id_id_unique").on(t.orgId, t.id),
    check("res_demand_lines_job_title_nonblank", sql`length(btrim(${t.jobTitle})) > 0`),
    check("res_demand_lines_first_week_sunday", sql`extract(dow from ${t.firstWeek}) = 0`),
    check("res_demand_lines_last_week_sunday", sql`extract(dow from ${t.lastWeek}) = 0`),
    check("res_demand_lines_week_order", sql`${t.firstWeek} <= ${t.lastWeek}`),
    check(
      "res_demand_lines_hours_per_week_range",
      sql`${t.hoursPerWeek} > 0 and ${t.hoursPerWeek} <= 168`,
    ),
  ],
);

/** Prepaid project hours or fees billed through ordinary customer invoices. */
export const resRetainers = pgTable(
  "res_retainers",
  {
    id: id(),
    orgId: orgRef(),
    projectId: uuid("project_id").notNull(),
    customerPartyId: uuid("customer_party_id").notNull(),
    kind: text("kind", { enum: RES_RETAINER_KIND_VALUES }).notNull(),
    totalAmount: money("total_amount").notNull(),
    totalHours: money("total_hours"),
    unitRate: money("unit_rate"),
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on").notNull(),
    retainerItemId: uuid("retainer_item_id").notNull(),
    invoiceDocumentId: uuid("invoice_document_id"),
    obligationId: uuid("obligation_id"),
    state: text("state", { enum: RES_RETAINER_STATE_VALUES }).notNull().default("draft"),
    custom: jsonb("custom").notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("res_retainers_org_id_id_unique").on(t.orgId, t.id),
    index("res_retainers_project").on(t.orgId, t.projectId),
    check("res_retainers_total_amount_positive", sql`${t.totalAmount} > 0`),
    check(
      "res_retainers_hours_terms",
      sql`(${t.kind} = 'hours' and ${t.totalHours} is not null and ${t.unitRate} is not null)
          or (${t.kind} = 'fees' and ${t.totalHours} is null and ${t.unitRate} is null)`,
    ),
    check("res_retainers_date_order", sql`${t.startsOn} <= ${t.endsOn}`),
  ],
);

/** Weekly retainer balance movement; posted amounts tie to recognition events. */
export const resRetainerDrawdowns = pgTable(
  "res_retainer_drawdowns",
  {
    id: id(),
    orgId: orgRef(),
    retainerId: uuid("retainer_id").notNull(),
    weekStart: date("week_start").notNull(),
    hours: money("hours").notNull(),
    amount: money("amount").notNull(),
    state: text("state", { enum: RES_RETAINER_DRAWDOWN_STATE_VALUES }).notNull().default("draft"),
    recognitionEventId: uuid("recognition_event_id"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("res_retainer_drawdowns_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("res_retainer_drawdowns_retainer_week").on(t.orgId, t.retainerId, t.weekStart),
    check("res_retainer_drawdowns_week_start_sunday", sql`extract(dow from ${t.weekStart}) = 0`),
    check("res_retainer_drawdowns_hours_nonnegative", sql`${t.hours} >= 0`),
    check("res_retainer_drawdowns_amount_positive", sql`${t.amount} > 0`),
  ],
);

/** Connects approved time evidence to the weekly retainer drawdown that uses it. */
export const resRetainerDrawdownEntries = pgTable(
  "res_retainer_drawdown_entries",
  {
    id: id(),
    orgId: orgRef(),
    drawdownId: uuid("drawdown_id").notNull(),
    timeEntryId: uuid("time_entry_id").notNull(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("res_retainer_drawdown_entries_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("res_retainer_drawdown_entries_time_entry").on(t.orgId, t.timeEntryId),
  ],
);
