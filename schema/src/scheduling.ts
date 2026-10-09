import { sql } from 'drizzle-orm';
import { boolean, date, integer, jsonb, pgTable, smallint, text, time, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

export const SCHEDULE_BOARD_ROW_KINDS = ["people", "tasks", "resources"] as const;
export const SCHEDULE_BOARD_GRAINS = ["day", "timed"] as const;
export const SCHEDULE_BOARD_VIEWS = {
  people: ["grid", "targets", "timeline", "calendar"],
  tasks: ["gantt", "progress"],
  resources: ["grid", "targets", "timeline", "calendar"],
} as const;
export const SCHEDULE_BOARD_RANGE_DAYS = [1, 3, 7, 14, 21, 28, 35, 42] as const;
export const SCHEDULE_PUBLISH_POLICIES = ["live", "staged"] as const;
export const SCHEDULE_CODE_CATEGORIES = ["work", "unavailable"] as const;
export const SCHEDULE_TARGET_KINDS = ["customer", "project", "location", "code"] as const;
export const SCHEDULE_ENTRY_STATUSES = ["draft", "published", "cancelled"] as const;
export const SCHEDULE_SPAN_MODES = ["day", "timed"] as const;

export type ScheduleBoardRowKind = (typeof SCHEDULE_BOARD_ROW_KINDS)[number];
export type ScheduleBoardView = (typeof SCHEDULE_BOARD_VIEWS)[ScheduleBoardRowKind][number];
export type ScheduleTargetKind = (typeof SCHEDULE_TARGET_KINDS)[number];
export type ScheduleEntryStatus = (typeof SCHEDULE_ENTRY_STATUSES)[number];

/** A scoped lens over people or project tasks, with its views and booking behavior. */
export const scheduleBoards = pgTable("schedule_boards", {
  id: id(),
  orgId: orgRef(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  rowKind: text("row_kind", { enum: SCHEDULE_BOARD_ROW_KINDS }).notNull(),
  resourceKind: text("resource_kind", { enum: ["equipment", "location"] }),
  cellColorRules: jsonb("cell_color_rules").notNull().default([]),
    showTotals: boolean("show_totals").notNull().default(false),
    automaticDeliveryPolicy: jsonb("automatic_delivery_policy").$type<
      Record<string, unknown>
    >(),
  showHoursColumn: boolean("show_hours_column").notNull().default(true),
  distributionVisibility:text("distribution_visibility",{enum:["personal","board"]}).notNull().default("personal"),
  weekendDays: text("weekend_days").array().notNull().default(["6", "7"]),
  subsidiaryId: uuid("subsidiary_id"),
  departmentId: uuid("department_id"),
  locationId: uuid("location_id"),
  projectId: uuid("project_id"),
  grain: text("grain", { enum: SCHEDULE_BOARD_GRAINS }).notNull().default("day"),
  views: text("views").array().notNull(),
  defaultView: text("default_view").notNull(),
  rangeDays: smallint("range_days").notNull().default(14),
  weekStartsOn: smallint("week_starts_on").notNull().default(0),
  showWeekends: boolean("show_weekends").notNull().default(true),
  timeZone: text("time_zone").notNull(),
  dayPolicyKnown: boolean('day_policy_known').notNull().default(true),
  dayStarts: time("day_starts").notNull().default("07:00"),
  dayEnds: time("day_ends").notNull().default("15:30"),
  dayBreakMinutes: smallint("day_break_minutes").notNull().default(30),
  publishPolicy: text("publish_policy", { enum: SCHEDULE_PUBLISH_POLICIES }).notNull().default("live"),
  prefillTimesheets: boolean("prefill_timesheets").notNull().default(false),
  prefillCrewTime: boolean("prefill_crew_time").notNull().default(false),
  prefillFieldTickets: boolean("prefill_field_tickets").notNull().default(false),
  notifyAssignees: boolean("notify_assignees").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  ...auditColumns,
}, (t) => [
  uniqueIndex("schedule_boards_org_id_id_key").on(t.orgId, t.id),
  uniqueIndex("schedule_boards_org_id_code_key").on(t.orgId, t.code),
]);

/** Organization-defined booking codes for non-project work and unavailability. */
export const scheduleCodes = pgTable("schedule_codes", {
  id: id(),
  orgId: orgRef(),
  code: text("code").notNull(),
  label: text("label").notNull(),
  description: text("description"),
  category: text("category", { enum: SCHEDULE_CODE_CATEGORIES }).notNull(),
  color: text("color").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  ...auditColumns,
}, (t) => [
  uniqueIndex("schedule_codes_org_id_id_key").on(t.orgId, t.id),
  uniqueIndex("schedule_codes_org_id_code_key").on(t.orgId, t.code),
]);

/** The booking ledger for people boards: one person, one target, one span. */
export const scheduleEntries = pgTable("schedule_entries", {
  id: id(),
  orgId: orgRef(),
  boardId: uuid("board_id").notNull(),
  workerPartyId: uuid("worker_party_id"),
  equipmentUnitId: uuid("equipment_unit_id"),
  resourceLocationId: uuid("resource_location_id"),
  employmentId: uuid("employment_id"),
  subsidiaryId: uuid("subsidiary_id"),
  targetKind: text("target_kind", { enum: SCHEDULE_TARGET_KINDS }),
  customerPartyId: uuid("customer_party_id"),
  projectId: uuid("project_id"),
  projectTaskId: uuid("project_task_id"),
  locationId: uuid("location_id"),
  scheduleCodeId: uuid("schedule_code_id"),
  departmentId: uuid("department_id"),
  detail: text("detail"),
  notes: text("notes"),
  spanMode: text("span_mode", { enum: SCHEDULE_SPAN_MODES }).notNull(),
  timeZone: text("time_zone").notNull(),
  startsOn: date("starts_on").notNull(),
  endsOn: date("ends_on").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  breakMinutes: smallint("break_minutes").notNull().default(0),
  seriesId: uuid("series_id"),
  supersedesId: uuid("supersedes_id"),
  status: text("status", { enum: SCHEDULE_ENTRY_STATUSES }).notNull(),
  publishedBy: uuid("published_by"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  reason: text("reason").notNull(),
  requestHash: text("request_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by").notNull(),
  revision: integer("revision").notNull().default(1),
}, (t) => [
  uniqueIndex("schedule_entries_org_id_id_key").on(t.orgId, t.id),
  uniqueIndex("schedule_entries_org_id_supersedes_id_key").on(t.orgId, t.supersedesId),
]);

/** Date-only source observations and reviewed native links; never worked time. */
export const scheduleSourceRecords = pgTable("schedule_source_records", {
  id: id(), orgId: orgRef(), sourceSystem: text('source_system').notNull(),
  sourceDataset: text('source_dataset').notNull(), sourceKey: text('source_key').notNull(),
  sourceHash: text('source_hash').notNull(), assessmentHash: text('assessment_hash').notNull(),
  captureHash: text('capture_hash').notNull(), sourcePayload: jsonb('source_payload').notNull(),
  disposition: text('disposition', { enum: ['recorded','linked','exception'] }).notNull(),
  boardId: uuid('board_id'), workerPartyId: uuid('worker_party_id'), subsidiaryId: uuid('subsidiary_id'),
  onDate: date('on_date'), label: text('label'), sourceResult: text('source_result'), sourceNotes: text('source_notes'),
  visibleInSource: boolean('visible_in_source').notNull(), linkedEntryId: uuid('linked_entry_id'),
  supersedesId: uuid('supersedes_id'), reason: text('reason').notNull(),
  createdAt: timestamp('created_at', { withTimezone:true }).notNull().defaultNow(), createdBy: uuid('created_by').notNull(),
  },
  (t) => [
  uniqueIndex('schedule_source_records_org_id_id_key').on(t.orgId,t.id),
  uniqueIndex('schedule_source_records_org_id_supersedes_id_key').on(t.orgId,t.supersedesId),
]);

/** Native associations resolve recipients from parties; equipment never becomes a parallel roster. */
export const scheduleResourceRecipients=pgTable('schedule_resource_recipients',{
 id:id(),orgId:orgRef(),boardId:uuid('board_id').notNull(),equipmentUnitId:uuid('equipment_unit_id'),resourceLocationId:uuid('resource_location_id'),partyId:uuid('party_id').notNull(),subsidiaryId:uuid('subsidiary_id'),reason:text('reason').notNull(),revision:integer('revision').notNull().default(1),isActive:boolean('is_active').notNull().default(true),...auditColumns,
  },
  (t) => [
    uniqueIndex("schedule_resource_recipients_org_id_id_key").on(t.orgId, t.id),
  ],
);
export const scheduleDistributions=pgTable('schedule_distributions',{
 id:id(),orgId:orgRef(),boardId:uuid('board_id').notNull(),subsidiaryId:uuid('subsidiary_id'),fromDate:date('from_date').notNull(),throughDate:date('through_date').notNull(),version:text('version').notNull(),audience:jsonb('audience').notNull(),reason:text('reason').notNull(),replayKey:text('replay_key').notNull(),status:text('status',{enum:['previewed','queued']}).notNull().default('previewed'),flowRunId:uuid('flow_run_id'),queuedAt:timestamp('queued_at',{withTimezone:true}),createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),createdBy:uuid('created_by').notNull(),
  },
  (t) => [
    uniqueIndex("schedule_distributions_org_id_id_key").on(t.orgId, t.id),
    uniqueIndex("schedule_distributions_org_id_replay_key_key").on(
      t.orgId,
      t.replayKey,
    ),
    uniqueIndex("schedule_distributions_version_key")
      .on(t.orgId, t.boardId, t.version)
      .where(
        sql`${t.status} = 'queued' and ${t.replayKey} not like 'automatic:%'`,
      ),
  ],
);
export const scheduleDistributionRecipients=pgTable('schedule_distribution_recipients',{
 id:id(),orgId:orgRef(),distributionId:uuid('distribution_id').notNull(),partyId:uuid('party_id').notNull(),workerPartyId:uuid('worker_party_id'),equipmentUnitId:uuid('equipment_unit_id'),resourceLocationId:uuid('resource_location_id'),email:text('email'),report:jsonb('report').notNull(),createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("schedule_distribution_recipients_org_id_id_key").on(
      t.orgId,
      t.id,
    ),
  ],
);
