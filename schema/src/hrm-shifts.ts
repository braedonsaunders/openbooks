import { bigint, boolean, date, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { id, orgRef } from "./helpers";

const history = () => ({
  revision: integer("revision").notNull().default(1), reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), createdBy: uuid("created_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(), updatedBy: uuid("updated_by").notNull(),
});
const creation = () => ({
  requestHash: text("request_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), createdBy: uuid("created_by").notNull(),
  reason: text("reason").notNull(),
});
const decision = () => ({
  authorPartyId: uuid("author_party_id").notNull(), decidedBy: uuid("decided_by"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
});
const subject = () => ({
  subsidiaryId: uuid("subsidiary_id").notNull(), employmentId: uuid("employment_id").notNull(), workerPartyId: uuid("worker_party_id").notNull(),
});

/** Approved definitions freeze the native cycle and operational clock times. */
export const hrmShiftTemplates = pgTable("hrm_shift_templates", {
  id: id(), orgId: orgRef(), subsidiaryId: uuid("subsidiary_id").notNull(), normalWorkScheduleId: uuid("normal_work_schedule_id").notNull(),
  code: text("code").notNull(), version: integer("version").notNull(), name: text("name").notNull(), description: text("description"),
  effectiveFrom: date("effective_from").notNull(), effectiveTo: date("effective_to"),
  pattern: jsonb("pattern").notNull(), attendancePolicy: jsonb("attendance_policy"), definitionHash: text("definition_hash").notNull(),
  status: text("status", { enum: ["draft", "approved", "retired", "cancelled"] }).notNull().default("draft"),
  requestHash: text("request_hash").notNull(), ...decision(), ...history(),
}, t => [uniqueIndex("hrm_shift_templates_org_id_id_key").on(t.orgId, t.id), uniqueIndex("hrm_shift_templates_version_key").on(t.orgId, t.subsidiaryId, t.code, t.version)]);

/** Assignment end dates are exclusive, matching native employment history. */
export const hrmShiftAssignments = pgTable("hrm_shift_assignments", {
  id: id(), orgId: orgRef(), templateId: uuid("template_id").notNull(), ...subject(),
  effectiveFrom: date("effective_from").notNull(), effectiveTo: date("effective_to"),
  status: text("status", { enum: ["draft", "approved", "ended", "cancelled"] }).notNull().default("draft"),
  requestHash: text("request_hash").notNull(), ...decision(), ...history(),
}, t => [uniqueIndex("hrm_shift_assignments_org_id_id_key").on(t.orgId, t.id)]);

/** A publication is observable even when its bounded calendar window contains only days off. */
export const hrmShiftPublications = pgTable("hrm_shift_publications", {
  id: id(), orgId: orgRef(), assignmentId: uuid("assignment_id").notNull(), fromOn: date("from_on").notNull(), throughOn: date("through_on").notNull(),
  assignmentRevision: integer("assignment_revision").notNull(), definitionHash: text("definition_hash").notNull(),
  occurrenceSelections: jsonb("occurrence_selections").notNull(), ...creation(),
}, t => [uniqueIndex("hrm_shift_publications_org_id_id_key").on(t.orgId, t.id)]);

/** Operational shifts retain exact instants; their publication creates no financial input. */
export const hrmShifts = pgTable("hrm_shifts", {
  id: id(), orgId: orgRef(), ...subject(), templateId: uuid("template_id"), publicationId: uuid("publication_id"), slotIndex: integer("slot_index"),
  name: text("name").notNull(), timeZone: text("time_zone").notNull(), startsOn: date("starts_on").notNull(), endsOn: date("ends_on").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(), endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  plannedBreakSeconds: integer("planned_break_seconds").notNull(), qualificationTypeIds: jsonb("qualification_type_ids").notNull(),
  attendancePolicy: jsonb("attendance_policy"), definitionHash: text("definition_hash").notNull(), supersedesId: uuid("supersedes_id"), originRequestId: uuid("origin_request_id"),
  status: text("status", { enum: ["draft", "published", "closed", "cancelled"] }).notNull().default("draft"),
  requestHash: text("request_hash").notNull(), ...decision(), ...history(),
}, t => [uniqueIndex("hrm_shifts_org_id_id_key").on(t.orgId, t.id), uniqueIndex("hrm_shifts_publication_slot_key").on(t.orgId, t.publicationId, t.startsOn, t.slotIndex)]);

export const hrmShiftRequests = pgTable("hrm_shift_requests", {
  id: id(), orgId: orgRef(), shiftId: uuid("shift_id").notNull(), ...subject(), shiftRevision: integer("shift_revision").notNull(),
  kind: text("kind", { enum: ["release", "change"] }).notNull(), proposedStartsAt: timestamp("proposed_starts_at", { withTimezone: true }),
  proposedEndsAt: timestamp("proposed_ends_at", { withTimezone: true }), outcomeShiftId: uuid("outcome_shift_id"),
  status: text("status", { enum: ["pending", "approved", "declined", "withdrawn"] }).notNull().default("pending"),
  requestHash: text("request_hash").notNull(), ...decision(), ...history(),
}, t => [uniqueIndex("hrm_shift_requests_org_id_id_key").on(t.orgId, t.id)]);

export const hrmAttendanceDevices = pgTable("hrm_attendance_devices", {
  id: id(), orgId: orgRef(), subsidiaryId: uuid("subsidiary_id").notNull(), code: text("code").notNull(),
  name: text("name").notNull(), timeZone: text("time_zone").notNull(), isActive: boolean("is_active").notNull().default(true),
  requestHash: text("request_hash").notNull(), ...history(),
}, t => [uniqueIndex("hrm_attendance_devices_org_id_id_key").on(t.orgId, t.id), uniqueIndex("hrm_attendance_devices_code_key").on(t.orgId, t.code)]);

/** Device identifiers map to stable employments over explicit half-open calendar intervals. */
export const hrmAttendanceIdentities = pgTable("hrm_attendance_identities", {
  id: id(), orgId: orgRef(), deviceId: uuid("device_id").notNull(), sourceWorkerId: text("source_worker_id").notNull(), ...subject(),
  effectiveFrom: date("effective_from").notNull(), effectiveTo: date("effective_to"),
  requestHash: text("request_hash").notNull(), ...history(),
}, t => [uniqueIndex("hrm_attendance_identities_org_id_id_key").on(t.orgId, t.id)]);

/** A synchronization batch retains source evidence, event count and declared completeness. */
export const hrmAttendanceBatches = pgTable("hrm_attendance_batches", {
  id: id(), orgId: orgRef(), deviceId: uuid("device_id").notNull(), completeThrough: timestamp("complete_through", { withTimezone: true }),
  sourceEvidence: jsonb("source_evidence").notNull(), eventCount: integer("event_count").notNull(), ...creation(),
}, t => [uniqueIndex("hrm_attendance_batches_org_id_id_key").on(t.orgId, t.id)]);

export const hrmAttendanceEvents = pgTable("hrm_attendance_events", {
  id: id(), orgId: orgRef(), deviceId: uuid("device_id").notNull(), batchId: uuid("batch_id").notNull(), identityId: uuid("identity_id").notNull(), ...subject(),
  sourceEventId: text("source_event_id").notNull(), sourceVersion: integer("source_version").notNull(),
  kind: text("kind", { enum: ["clock_in", "clock_out", "break_start", "break_end", "void"] }).notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(), sourceLocalDate: date("source_local_date").notNull(),
  sourcePayload: jsonb("source_payload").notNull(), supersedesId: uuid("supersedes_id"), ...creation(),
}, t => [uniqueIndex("hrm_attendance_events_org_id_id_key").on(t.orgId, t.id), uniqueIndex("hrm_attendance_events_source_version_key").on(t.orgId, t.deviceId, t.sourceEventId, t.sourceVersion), uniqueIndex("hrm_attendance_events_successor_key").on(t.orgId, t.supersedesId)]);

export const hrmAttendanceWatermarks = pgTable("hrm_attendance_watermarks", {
  id: id(), orgId: orgRef(), deviceId: uuid("device_id").notNull(), batchId: uuid("batch_id").notNull(),
  completeThrough: timestamp("complete_through", { withTimezone: true }).notNull(), requestHash: text("request_hash").notNull(), ...history(),
}, t => [uniqueIndex("hrm_attendance_watermarks_org_id_id_key").on(t.orgId, t.id), uniqueIndex("hrm_attendance_watermarks_device_key").on(t.orgId, t.deviceId)]);

/** Observations are immutable revisions of source evidence, distinct from approved work and pay. */
export const hrmAttendanceObservations = pgTable("hrm_attendance_observations", {
  id: id(), orgId: orgRef(), shiftId: uuid("shift_id").notNull(), ...subject(),
  status: text("status", { enum: ["waiting_for_sync", "absent", "present", "voided"] }).notNull(),
  completeThrough: timestamp("complete_through", { withTimezone: true }), firstIn: timestamp("first_in", { withTimezone: true }), lastOut: timestamp("last_out", { withTimezone: true }),
  presenceMilliseconds: bigint("presence_milliseconds", { mode: "bigint" }), breakMilliseconds: bigint("break_milliseconds", { mode: "bigint" }),
  late: boolean("late"), leftEarly: boolean("left_early"), sourceEvidence: jsonb("source_evidence").notNull(), evidenceHash: text("evidence_hash").notNull(),
  supersedesId: uuid("supersedes_id"), ...creation(),
}, t => [uniqueIndex("hrm_attendance_observations_org_id_id_key").on(t.orgId, t.id), uniqueIndex("hrm_attendance_observations_successor_key").on(t.orgId, t.supersedesId)]);

/** Event claims retain shift ownership and controlled release evidence. */
export const hrmAttendanceEventClaims = pgTable("hrm_attendance_event_claims", {
  id: id(), orgId: orgRef(), eventId: uuid("event_id").notNull(), shiftId: uuid("shift_id").notNull(),
  releasedAt: timestamp("released_at", { withTimezone: true }), releasedBy: uuid("released_by"), releaseReason: text("release_reason"), ...creation(),
}, t => [uniqueIndex("hrm_attendance_event_claims_org_id_id_key").on(t.orgId, t.id)]);

export const hrmAttendanceObservationEvents = pgTable("hrm_attendance_observation_events", {
  id: id(), orgId: orgRef(), observationId: uuid("observation_id").notNull(), eventClaimId: uuid("event_claim_id").notNull(),
  ...creation(),
}, t => [uniqueIndex("hrm_attendance_observation_events_org_id_id_key").on(t.orgId, t.id), uniqueIndex("hrm_attendance_observation_events_key").on(t.orgId, t.observationId, t.eventClaimId)]);
