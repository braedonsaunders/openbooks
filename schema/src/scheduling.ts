import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

export const SCHEDULE_BOARD_ROW_KINDS = ["people", "tasks", "resources"] as const;
export const SCHEDULE_BOARD_GRAINS = ["day", "timed"] as const;
export const SCHEDULE_BOARD_VIEWS = {
  people: ["grid", "targets", "timeline", "calendar", "dispatch"],
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
export const scheduleBoards = pgTable(
  "schedule_boards",
  {
    id: id(),
    orgId: orgRef(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    rowKind: text("row_kind", { enum: SCHEDULE_BOARD_ROW_KINDS }).notNull(),
    resourceKind: text("resource_kind", { enum: ["equipment", "location"] }),
    cellColorRules: jsonb("cell_color_rules").notNull().default([]),
    showTotals: boolean("show_totals").notNull().default(false),
    automaticDeliveryPolicy: jsonb("automatic_delivery_policy").$type<Record<string, unknown>>(),
    showHoursColumn: boolean("show_hours_column").notNull().default(true),
    distributionVisibility: text("distribution_visibility", { enum: ["personal", "board"] })
      .notNull()
      .default("personal"),
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
    dayPolicyKnown: boolean("day_policy_known").notNull().default(true),
    dayStarts: time("day_starts").notNull().default("07:00"),
    dayEnds: time("day_ends").notNull().default("15:30"),
    dayBreakMinutes: smallint("day_break_minutes").notNull().default(30),
    publishPolicy: text("publish_policy", { enum: SCHEDULE_PUBLISH_POLICIES })
      .notNull()
      .default("live"),
    prefillTimesheets: boolean("prefill_timesheets").notNull().default(false),
    prefillCrewTime: boolean("prefill_crew_time").notNull().default(false),
    prefillFieldTickets: boolean("prefill_field_tickets").notNull().default(false),
    notifyAssignees: boolean("notify_assignees").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("schedule_boards_org_id_id_key").on(t.orgId, t.id),
    uniqueIndex("schedule_boards_org_id_code_key").on(t.orgId, t.code),
  ],
);

/** Organization-defined booking codes for non-project work and unavailability. */
export const scheduleCodes = pgTable(
  "schedule_codes",
  {
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
  },
  (t) => [
    uniqueIndex("schedule_codes_org_id_id_key").on(t.orgId, t.id),
    uniqueIndex("schedule_codes_org_id_code_key").on(t.orgId, t.code),
  ],
);

/** The booking ledger for people boards: one person, one target, one span. */
export const scheduleEntries = pgTable(
  "schedule_entries",
  {
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
    /** Recorded from the board's governed-from date when the booking is created. */
    governed: boolean("governed").notNull().default(false),
    patternAssignmentId: uuid("pattern_assignment_id"),
    patternOccursOn: date("pattern_occurs_on"),
    patternSlot: smallint("pattern_slot"),
    /** A person changed this pattern-generated booking; regeneration keeps it. */
    patternOverride: boolean("pattern_override").notNull().default(false),
    originRequestId: uuid("origin_request_id"),
    /** A draft revision removing the governed booking it supersedes. */
    removesPredecessor: boolean("removes_predecessor").notNull().default(false),
    requiredQualificationTypeIds: uuid("required_qualification_type_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: uuid("closed_by"),
    closeReason: text("close_reason"),
    /** The service visit a dispatch booking serves; replacements keep it. */
    serviceVisitId: uuid("service_visit_id"),
  },
  (t) => [
    uniqueIndex("schedule_entries_org_id_id_key").on(t.orgId, t.id),
    uniqueIndex("schedule_entries_org_id_supersedes_id_key")
      .on(t.orgId, t.supersedesId)
      .where(sql`${t.supersedesId} is not null and ${t.status} <> 'cancelled'`),
  ],
);

/** Date-only source observations and reviewed native links; never worked time. */
export const scheduleSourceRecords = pgTable(
  "schedule_source_records",
  {
    id: id(),
    orgId: orgRef(),
    sourceSystem: text("source_system").notNull(),
    sourceDataset: text("source_dataset").notNull(),
    sourceKey: text("source_key").notNull(),
    sourceHash: text("source_hash").notNull(),
    assessmentHash: text("assessment_hash").notNull(),
    captureHash: text("capture_hash").notNull(),
    sourcePayload: jsonb("source_payload").notNull(),
    disposition: text("disposition", { enum: ["recorded", "linked", "exception"] }).notNull(),
    boardId: uuid("board_id"),
    workerPartyId: uuid("worker_party_id"),
    subsidiaryId: uuid("subsidiary_id"),
    onDate: date("on_date"),
    label: text("label"),
    sourceResult: text("source_result"),
    sourceNotes: text("source_notes"),
    visibleInSource: boolean("visible_in_source").notNull(),
    linkedEntryId: uuid("linked_entry_id"),
    supersedesId: uuid("supersedes_id"),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    uniqueIndex("schedule_source_records_org_id_id_key").on(t.orgId, t.id),
    uniqueIndex("schedule_source_records_org_id_supersedes_id_key").on(t.orgId, t.supersedesId),
  ],
);

/** Native associations resolve recipients from parties; equipment never becomes a parallel roster. */
export const scheduleResourceRecipients = pgTable(
  "schedule_resource_recipients",
  {
    id: id(),
    orgId: orgRef(),
    boardId: uuid("board_id").notNull(),
    equipmentUnitId: uuid("equipment_unit_id"),
    resourceLocationId: uuid("resource_location_id"),
    partyId: uuid("party_id").notNull(),
    subsidiaryId: uuid("subsidiary_id"),
    reason: text("reason").notNull(),
    revision: integer("revision").notNull().default(1),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [uniqueIndex("schedule_resource_recipients_org_id_id_key").on(t.orgId, t.id)],
);
export const scheduleDistributions = pgTable(
  "schedule_distributions",
  {
    id: id(),
    orgId: orgRef(),
    boardId: uuid("board_id").notNull(),
    subsidiaryId: uuid("subsidiary_id"),
    fromDate: date("from_date").notNull(),
    throughDate: date("through_date").notNull(),
    version: text("version").notNull(),
    audience: jsonb("audience").notNull(),
    reason: text("reason").notNull(),
    replayKey: text("replay_key").notNull(),
    status: text("status", { enum: ["previewed", "queued"] })
      .notNull()
      .default("previewed"),
    flowRunId: uuid("flow_run_id"),
    queuedAt: timestamp("queued_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    uniqueIndex("schedule_distributions_org_id_id_key").on(t.orgId, t.id),
    uniqueIndex("schedule_distributions_org_id_replay_key_key").on(t.orgId, t.replayKey),
    uniqueIndex("schedule_distributions_version_key")
      .on(t.orgId, t.boardId, t.version)
      .where(sql`${t.status} = 'queued' and ${t.replayKey} not like 'automatic:%'`),
  ],
);
export const scheduleDistributionRecipients = pgTable(
  "schedule_distribution_recipients",
  {
    id: id(),
    orgId: orgRef(),
    distributionId: uuid("distribution_id").notNull(),
    partyId: uuid("party_id").notNull(),
    workerPartyId: uuid("worker_party_id"),
    equipmentUnitId: uuid("equipment_unit_id"),
    resourceLocationId: uuid("resource_location_id"),
    email: text("email"),
    report: jsonb("report").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("schedule_distribution_recipients_org_id_id_key").on(t.orgId, t.id)],
);

/** A pattern slot: cycle day, local clock times (an end at or before the start ends the next day), planned break and required qualifications. */
export interface SchedulePatternSlot {
  readonly position: number;
  readonly starts: string;
  readonly ends: string;
  readonly breakMinutes: number;
  readonly qualificationTypeIds: readonly string[];
}

/** Recurring shift patterns: a repeating cycle of local clock-time slots with an optional booking target. */
export const schedulePatterns = pgTable(
  "schedule_patterns",
  {
    id: id(),
    orgId: orgRef(),
    subsidiaryId: uuid("subsidiary_id"),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    timeZone: text("time_zone").notNull(),
    cycleDays: smallint("cycle_days").notNull(),
    cycleAnchor: date("cycle_anchor").notNull(),
    slots: jsonb("slots").$type<SchedulePatternSlot[]>().notNull(),
    targetKind: text("target_kind", { enum: SCHEDULE_TARGET_KINDS }),
    customerPartyId: uuid("customer_party_id"),
    projectId: uuid("project_id"),
    projectTaskId: uuid("project_task_id"),
    locationId: uuid("location_id"),
    scheduleCodeId: uuid("schedule_code_id"),
    departmentId: uuid("department_id"),
    detail: text("detail"),
    horizonDays: smallint("horizon_days").notNull().default(28),
    isActive: boolean("is_active").notNull().default(true),
    reason: text("reason").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by").notNull(),
  },
  (t) => [uniqueIndex("schedule_patterns_org_id_id_key").on(t.orgId, t.id)],
);

/** A person working a pattern on a people board over a half-open effective window. */
export const schedulePatternAssignments = pgTable(
  "schedule_pattern_assignments",
  {
    id: id(),
    orgId: orgRef(),
    boardId: uuid("board_id").notNull(),
    patternId: uuid("pattern_id").notNull(),
    workerPartyId: uuid("worker_party_id").notNull(),
    employmentId: uuid("employment_id"),
    subsidiaryId: uuid("subsidiary_id"),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    status: text("status", { enum: ["active", "ended", "cancelled"] })
      .notNull()
      .default("active"),
    generatedThrough: date("generated_through"),
    lastGeneration: jsonb("last_generation").$type<Record<string, unknown>>(),
    reason: text("reason").notNull(),
    requestHash: text("request_hash").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by").notNull(),
  },
  (t) => [uniqueIndex("schedule_pattern_assignments_org_id_id_key").on(t.orgId, t.id)],
);

/** An omitted occurrence, or the selected instants of a clock time repeated by a daylight-saving change. */
export const schedulePatternExceptions = pgTable(
  "schedule_pattern_exceptions",
  {
    id: id(),
    orgId: orgRef(),
    assignmentId: uuid("assignment_id").notNull(),
    occursOn: date("occurs_on").notNull(),
    slotIndex: smallint("slot_index").notNull(),
    kind: text("kind", { enum: ["omit", "select_instant"] }).notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by"),
    revokeReason: text("revoke_reason"),
  },
  (t) => [uniqueIndex("schedule_pattern_exceptions_org_id_id_key").on(t.orgId, t.id)],
);

export const SCHEDULE_REQUEST_KINDS = ["release", "change", "swap"] as const;
export const SCHEDULE_REQUEST_STATUSES = [
  "awaiting_counterpart",
  "pending",
  "approved",
  "declined",
  "withdrawn",
] as const;

/** An employee's request to release, change or swap their own published booking. */
export const scheduleEntryRequests = pgTable(
  "schedule_entry_requests",
  {
    id: id(),
    orgId: orgRef(),
    boardId: uuid("board_id").notNull(),
    entryId: uuid("entry_id").notNull(),
    entryRevision: integer("entry_revision").notNull(),
    workerPartyId: uuid("worker_party_id").notNull(),
    subsidiaryId: uuid("subsidiary_id"),
    kind: text("kind", { enum: SCHEDULE_REQUEST_KINDS }).notNull(),
    proposedStartsAt: timestamp("proposed_starts_at", { withTimezone: true }),
    proposedEndsAt: timestamp("proposed_ends_at", { withTimezone: true }),
    proposedBreakMinutes: smallint("proposed_break_minutes"),
    counterpartEntryId: uuid("counterpart_entry_id"),
    counterpartEntryRevision: integer("counterpart_entry_revision"),
    counterpartPartyId: uuid("counterpart_party_id"),
    counterpartRespondedBy: uuid("counterpart_responded_by"),
    counterpartRespondedAt: timestamp("counterpart_responded_at", { withTimezone: true }),
    status: text("status", { enum: SCHEDULE_REQUEST_STATUSES }).notNull(),
    flowRunId: uuid("flow_run_id"),
    /** No approval Flow gated the request, so it was applied when submitted. */
    releasedWithoutApproval: boolean("released_without_approval").notNull().default(false),
    decidedBy: uuid("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionReason: text("decision_reason"),
    reason: text("reason").notNull(),
    requestHash: text("request_hash").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by").notNull(),
  },
  (t) => [uniqueIndex("schedule_entry_requests_org_id_id_key").on(t.orgId, t.id)],
);

/** Time-clock sources of a legal entity; code, legal entity and time zone are fixed. */
export const scheduleAttendanceDevices = pgTable(
  "schedule_attendance_devices",
  {
    id: id(),
    orgId: orgRef(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    timeZone: text("time_zone").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    reason: text("reason").notNull(),
    requestHash: text("request_hash").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by").notNull(),
  },
  (t) => [
    uniqueIndex("schedule_attendance_devices_org_id_id_key").on(t.orgId, t.id),
    uniqueIndex("schedule_attendance_devices_org_id_code_key").on(t.orgId, t.code),
  ],
);

/** A device's source worker identifier mapped to one person over a half-open date window. */
export const scheduleAttendanceIdentities = pgTable(
  "schedule_attendance_identities",
  {
    id: id(),
    orgId: orgRef(),
    deviceId: uuid("device_id").notNull(),
    sourceWorkerId: text("source_worker_id").notNull(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    workerPartyId: uuid("worker_party_id").notNull(),
    employmentId: uuid("employment_id"),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    reason: text("reason").notNull(),
    requestHash: text("request_hash").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by").notNull(),
  },
  (t) => [uniqueIndex("schedule_attendance_identities_org_id_id_key").on(t.orgId, t.id)],
);

/** Effective-dated attendance capture windows and grace bounds of a board. */
export const scheduleAttendancePolicies = pgTable(
  "schedule_attendance_policies",
  {
    id: id(),
    orgId: orgRef(),
    boardId: uuid("board_id").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    captureBeforeMinutes: smallint("capture_before_minutes").notNull(),
    captureAfterMinutes: smallint("capture_after_minutes").notNull(),
    lateGraceMinutes: smallint("late_grace_minutes").notNull(),
    earlyGraceMinutes: smallint("early_grace_minutes").notNull(),
    breakGraceMinutes: smallint("break_grace_minutes").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    uniqueIndex("schedule_attendance_policies_org_id_id_key").on(t.orgId, t.id),
    uniqueIndex("schedule_attendance_policies_org_id_board_id_effective_from_key").on(
      t.orgId,
      t.boardId,
      t.effectiveFrom,
    ),
  ],
);

/** An admitted check-in batch with its source evidence and declared completeness. */
export const scheduleAttendanceBatches = pgTable(
  "schedule_attendance_batches",
  {
    id: id(),
    orgId: orgRef(),
    deviceId: uuid("device_id").notNull(),
    completeThrough: timestamp("complete_through", { withTimezone: true }),
    isCorrection: boolean("is_correction").notNull().default(false),
    sourceEvidence: jsonb("source_evidence").notNull(),
    eventCount: integer("event_count").notNull(),
    reason: text("reason").notNull(),
    requestHash: text("request_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [uniqueIndex("schedule_attendance_batches_org_id_id_key").on(t.orgId, t.id)],
);

export const scheduleAttendanceEvents = pgTable(
  "schedule_attendance_events",
  {
    id: id(),
    orgId: orgRef(),
    deviceId: uuid("device_id").notNull(),
    batchId: uuid("batch_id").notNull(),
    identityId: uuid("identity_id").notNull(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    workerPartyId: uuid("worker_party_id").notNull(),
    employmentId: uuid("employment_id"),
    sourceEventId: text("source_event_id").notNull(),
    sourceVersion: integer("source_version").notNull(),
    kind: text("kind", {
      enum: ["clock_in", "clock_out", "break_start", "break_end", "void"],
    }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    sourceLocalDate: date("source_local_date").notNull(),
    sourcePayload: jsonb("source_payload").notNull(),
    supersedesId: uuid("supersedes_id"),
    reason: text("reason").notNull(),
    requestHash: text("request_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    uniqueIndex("schedule_attendance_events_org_id_id_key").on(t.orgId, t.id),
    uniqueIndex("schedule_attendance_events_source_version_key").on(
      t.orgId,
      t.deviceId,
      t.sourceEventId,
      t.sourceVersion,
    ),
  ],
);

export const scheduleAttendanceWatermarks = pgTable(
  "schedule_attendance_watermarks",
  {
    id: id(),
    orgId: orgRef(),
    deviceId: uuid("device_id").notNull(),
    batchId: uuid("batch_id").notNull(),
    completeThrough: timestamp("complete_through", { withTimezone: true }).notNull(),
    reason: text("reason").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by").notNull(),
  },
  (t) => [
    uniqueIndex("schedule_attendance_watermarks_org_id_id_key").on(t.orgId, t.id),
    uniqueIndex("schedule_attendance_watermarks_device_key").on(t.orgId, t.deviceId),
  ],
);

export const SCHEDULE_ATTENDANCE_STATUSES = [
  "waiting_for_sync",
  "absent",
  "present",
  "voided",
] as const;

/** Immutable attendance observations of published bookings; corrections supersede the latest. */
export const scheduleAttendanceObservations = pgTable(
  "schedule_attendance_observations",
  {
    id: id(),
    orgId: orgRef(),
    entryId: uuid("entry_id").notNull(),
    boardId: uuid("board_id").notNull(),
    policyId: uuid("policy_id"),
    subsidiaryId: uuid("subsidiary_id"),
    workerPartyId: uuid("worker_party_id").notNull(),
    employmentId: uuid("employment_id"),
    status: text("status", { enum: SCHEDULE_ATTENDANCE_STATUSES }).notNull(),
    completeThrough: timestamp("complete_through", { withTimezone: true }),
    firstIn: timestamp("first_in", { withTimezone: true }),
    lastOut: timestamp("last_out", { withTimezone: true }),
    presenceMilliseconds: bigint("presence_milliseconds", { mode: "bigint" }),
    breakMilliseconds: bigint("break_milliseconds", { mode: "bigint" }),
    late: boolean("late"),
    leftEarly: boolean("left_early"),
    overBreak: boolean("over_break"),
    sourceEvidence: jsonb("source_evidence").notNull(),
    evidenceHash: text("evidence_hash").notNull(),
    supersedesId: uuid("supersedes_id"),
    reason: text("reason").notNull(),
    requestHash: text("request_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [uniqueIndex("schedule_attendance_observations_org_id_id_key").on(t.orgId, t.id)],
);

/** Attribution of a check-in to one booking, released once with its actor and reason. */
export const scheduleAttendanceEventClaims = pgTable(
  "schedule_attendance_event_claims",
  {
    id: id(),
    orgId: orgRef(),
    eventId: uuid("event_id").notNull(),
    entryId: uuid("entry_id").notNull(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releasedBy: uuid("released_by"),
    releaseReason: text("release_reason"),
    reason: text("reason").notNull(),
    requestHash: text("request_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [uniqueIndex("schedule_attendance_event_claims_org_id_id_key").on(t.orgId, t.id)],
);

export const scheduleAttendanceObservationEvents = pgTable(
  "schedule_attendance_observation_events",
  {
    id: id(),
    orgId: orgRef(),
    observationId: uuid("observation_id").notNull(),
    eventClaimId: uuid("event_claim_id").notNull(),
    reason: text("reason").notNull(),
    requestHash: text("request_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [uniqueIndex("schedule_attendance_observation_events_org_id_id_key").on(t.orgId, t.id)],
);

/** A governed board's publication of its unpublished changes, decided through any configured approval Flow. */
export const schedulePublications = pgTable(
  "schedule_publications",
  {
    id: id(),
    orgId: orgRef(),
    boardId: uuid("board_id").notNull(),
    subsidiaryId: uuid("subsidiary_id"),
    fromDate: date("from_date").notNull(),
    throughDate: date("through_date").notNull(),
    entryIds: uuid("entry_ids").array().notNull(),
    entryRevisions: integer("entry_revisions").array().notNull(),
    status: text("status", { enum: ["pending", "approved", "declined", "withdrawn"] })
      .notNull()
      .default("pending"),
    flowRunId: uuid("flow_run_id"),
    releasedWithoutApproval: boolean("released_without_approval").notNull().default(false),
    decidedBy: uuid("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionReason: text("decision_reason"),
    reason: text("reason").notNull(),
    requestHash: text("request_hash").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by").notNull(),
  },
  (t) => [uniqueIndex("schedule_publications_org_id_id_key").on(t.orgId, t.id)],
);
