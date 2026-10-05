import { date, integer, pgTable, text, timestamp, uniqueIndex, uuid, boolean } from "drizzle-orm/pg-core";
import { id, orgRef } from "./helpers";

/** Tenant references, lifecycle transitions and immutable evidence are enforced by migration 0553. */
const history = () => ({
  requestHash: text("request_hash").notNull(), revision: integer("revision").notNull().default(1), reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), createdBy: uuid("created_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(), updatedBy: uuid("updated_by").notNull(),
});
export const hrmTrainingCourses = pgTable("hrm_training_courses", {
  id: id(), orgId: orgRef(), subsidiaryId: uuid("subsidiary_id").notNull(), code: text("code").notNull(), version: integer("version").notNull(),
  name: text("name").notNull(), description: text("description"), effectiveFrom: date("effective_from").notNull(), effectiveTo: date("effective_to"),
  qualificationTypeId: uuid("qualification_type_id"), minimumAttendancePercent: integer("minimum_attendance_percent").notNull(), passingScore: integer("passing_score"),
  qualificationValidityMonths: integer("qualification_validity_months"), qualificationRequiresEvidence: boolean("qualification_requires_evidence").notNull().default(false),
  status: text("status", { enum: ["draft", "approved", "retired", "cancelled"] }).notNull().default("draft"),
  authorPartyId: uuid("author_party_id").notNull(), decidedBy: uuid("decided_by"), decidedAt: timestamp("decided_at", { withTimezone: true }), ...history(),
}, t => [uniqueIndex("hrm_training_courses_org_id_id_key").on(t.orgId, t.id), uniqueIndex("hrm_training_courses_org_id_subsidiary_id_code_version_key").on(t.orgId, t.subsidiaryId, t.code, t.version)]);
export const hrmTrainingSessions = pgTable("hrm_training_sessions", {
  id: id(), orgId: orgRef(), subsidiaryId: uuid("subsidiary_id").notNull(), courseId: uuid("course_id").notNull(), name: text("name").notNull(), location: text("location").notNull(),
  timeZone: text("time_zone").notNull(), startsAt: timestamp("starts_at", { withTimezone: true }).notNull(), endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  startsOn: date("starts_on").notNull(), endsOn: date("ends_on").notNull(), durationSeconds: integer("duration_seconds").notNull(), capacity: integer("capacity").notNull(),
  status: text("status", { enum: ["draft", "scheduled", "in_progress", "completed", "cancelled"] }).notNull().default("draft"), ...history(),
}, t => [uniqueIndex("hrm_training_sessions_org_id_id_key").on(t.orgId, t.id)]);
export const hrmTrainingParticipants = pgTable("hrm_training_participants", {
  id: id(), orgId: orgRef(), sessionId: uuid("session_id").notNull(), employmentId: uuid("employment_id").notNull(), subsidiaryId: uuid("subsidiary_id").notNull(),
  status: text("status", { enum: ["invited", "accepted", "declined", "completed", "failed", "voided", "cancelled"] }).notNull().default("invited"),
  attendanceSeconds: integer("attendance_seconds"), score: integer("score"), evidenceFileId: uuid("evidence_file_id"), notes: text("notes"),
  qualificationTypeId: uuid("qualification_type_id"), qualificationId: uuid("qualification_id"), qualificationCreated: boolean("qualification_created").notNull().default(false),
  completionHash: text("completion_hash"), ...history(),
}, t => [uniqueIndex("hrm_training_participants_org_id_id_key").on(t.orgId, t.id), uniqueIndex("hrm_training_participants_org_id_session_id_employment_id_key").on(t.orgId, t.sessionId, t.employmentId)]);
export const hrmTrainingFeedback = pgTable("hrm_training_feedback", {
  id: id(), orgId: orgRef(), participantId: uuid("participant_id").notNull(), rating: integer("rating").notNull(), comments: text("comments"),
  supersedesId: uuid("supersedes_id"), reason: text("reason").notNull(), requestHash: text("request_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), createdBy: uuid("created_by").notNull(),
}, t => [uniqueIndex("hrm_training_feedback_org_id_id_key").on(t.orgId, t.id), uniqueIndex("hrm_training_feedback_org_id_supersedes_id_key").on(t.orgId, t.supersedesId)]);
