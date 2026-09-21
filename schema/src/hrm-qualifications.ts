import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { files } from "./file-cabinet";
import { auditColumns, id, orgRef } from "./helpers";
import { workerEmployments } from "./hrm";

/**
 * HRM qualifications and dispatch gating (migration 0225) — drizzle mirror
 * of the published SQL.
 *
 * Stored status is only valid | revoked | pending_verification:
 * expiring/expired are derived at read from expires_on and the type's
 * lead days and never persisted. The category vocabulary is base-six plus
 * the org's extra list in hrm_qualification_settings (trigger-guarded in
 * SQL; the service validates first so the refusal names the Setup path).
 */

export const HRM_QUALIFICATION_CATEGORIES_BASE = [
  "certification",
  "license",
  "training",
  "medical",
  "clearance",
  "other",
] as const;

export const HRM_QUALIFICATION_STORED_STATUSES = [
  "valid",
  "revoked",
  "pending_verification",
] as const;

export const HRM_QUALIFICATION_EVENT_KINDS = [
  "recorded",
  "verified",
  "renewed",
  "revoked",
  "expired_noticed",
  "alert_sent",
  "warned",
] as const;

export const HRM_QUALIFICATION_SUBJECT_KINDS = [
  "project",
  "equipment",
  "position",
  "classification",
] as const;

export const HRM_QUALIFICATION_SEVERITIES = ["block", "warn"] as const;

export const HRM_QUALIFICATION_ALERT_CHANNELS = ["inbox", "email"] as const;

/** Qualification types (0225): the org-declared taxonomy. */
export const hrmQualificationTypes = pgTable(
  "hrm_qualification_types",
  {
    id: id(),
    orgId: orgRef(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    category: text("category").notNull(),
    issuingBody: text("issuing_body"),
    validityMonths: integer("validity_months"),
    renewalLeadDays: integer("renewal_lead_days").notNull().default(30),
    requiresEvidence: boolean("requires_evidence").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("hrm_qualification_types_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_qualification_types_org_code_unique").on(t.orgId, t.code),
    check("hrm_qualification_types_code", sql`char_length(btrim(${t.code})) > 0`),
    check("hrm_qualification_types_name", sql`char_length(btrim(${t.name})) > 0`),
    check(
      "hrm_qualification_types_category",
      sql`char_length(btrim(${t.category})) > 0`,
    ),
    check(
      "hrm_qualification_types_validity",
      sql`${t.validityMonths} is null or ${t.validityMonths} > 0`,
    ),
    check(
      "hrm_qualification_types_lead_days",
      sql`${t.renewalLeadDays} >= 0`,
    ),
  ],
);

/** Worker qualifications (0225): held credentials per employment record. */
export const hrmWorkerQualifications = pgTable(
  "hrm_worker_qualifications",
  {
    id: id(),
    orgId: orgRef(),
    employmentId: uuid("employment_id").notNull(),
    typeId: uuid("type_id").notNull(),
    identifier: text("identifier"),
    issuedOn: date("issued_on").notNull(),
    expiresOn: date("expires_on"),
    status: text("status", { enum: HRM_QUALIFICATION_STORED_STATUSES })
      .notNull()
      .default("pending_verification"),
    evidenceFileId: uuid("evidence_file_id"),
    verifiedBy: uuid("verified_by"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    notes: text("notes"),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_worker_qualifications_employment_fkey",
      columns: [t.orgId, t.employmentId],
      foreignColumns: [workerEmployments.orgId, workerEmployments.id],
    }),
    foreignKey({
      name: "hrm_worker_qualifications_type_fkey",
      columns: [t.orgId, t.typeId],
      foreignColumns: [hrmQualificationTypes.orgId, hrmQualificationTypes.id],
    }),
    foreignKey({
      name: "hrm_worker_qualifications_evidence_fkey",
      columns: [t.orgId, t.evidenceFileId],
      foreignColumns: [files.orgId, files.id],
    }),
    uniqueIndex("hrm_worker_qualifications_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex(
      "hrm_worker_qualifications_org_employment_type_issued_unique",
    ).on(t.orgId, t.employmentId, t.typeId, t.issuedOn),
    index("hrm_worker_qualifications_org_employment").on(t.orgId, t.employmentId),
    check(
      "hrm_worker_qualifications_window",
      sql`${t.expiresOn} is null or ${t.expiresOn} >= ${t.issuedOn}`,
    ),
    check(
      "hrm_worker_qualifications_verified_pair",
      sql`(${t.verifiedAt} is null and ${t.verifiedBy} is null) or (${t.verifiedAt} is not null and ${t.verifiedBy} is not null)`,
    ),
  ],
);

/** Qualification events (0225): append-only evidence ledger. */
export const hrmQualificationEvents = pgTable(
  "hrm_qualification_events",
  {
    id: id(),
    orgId: orgRef(),
    qualificationId: uuid("qualification_id").notNull(),
    relatedQualificationId: uuid("related_qualification_id"),
    kind: text("kind", { enum: HRM_QUALIFICATION_EVENT_KINDS }).notNull(),
    actorId: uuid("actor_id"),
    reason: text("reason"),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "hrm_qualification_events_qualification_fkey",
      columns: [t.orgId, t.qualificationId],
      foreignColumns: [hrmWorkerQualifications.orgId, hrmWorkerQualifications.id],
    }),
    foreignKey({
      name: "hrm_qualification_events_related_fkey",
      columns: [t.orgId, t.relatedQualificationId],
      foreignColumns: [hrmWorkerQualifications.orgId, hrmWorkerQualifications.id],
    }),
    uniqueIndex("hrm_qualification_events_org_id_id_unique").on(t.orgId, t.id),
    index("hrm_qualification_events_org_qualification").on(
      t.orgId,
      t.qualificationId,
      t.recordedAt,
    ),
    check(
      "hrm_qualification_events_reason",
      sql`${t.reason} is null or char_length(btrim(${t.reason})) > 0`,
    ),
  ],
);

/** Qualification requirements (0225): what a subject demands. */
export const hrmQualificationRequirements = pgTable(
  "hrm_qualification_requirements",
  {
    id: id(),
    orgId: orgRef(),
    subjectKind: text("subject_kind", {
      enum: HRM_QUALIFICATION_SUBJECT_KINDS,
    }).notNull(),
    subjectId: uuid("subject_id").notNull(),
    typeId: uuid("type_id").notNull(),
    requiredFrom: date("required_from").notNull().default(sql`current_date`),
    requiredTo: date("required_to"),
    severity: text("severity", { enum: HRM_QUALIFICATION_SEVERITIES })
      .notNull()
      .default("block"),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_qualification_requirements_type_fkey",
      columns: [t.orgId, t.typeId],
      foreignColumns: [hrmQualificationTypes.orgId, hrmQualificationTypes.id],
    }),
    uniqueIndex("hrm_qualification_requirements_org_id_id_unique").on(
      t.orgId,
      t.id,
    ),
    uniqueIndex("hrm_qualification_requirements_org_subject_type_unique").on(
      t.orgId,
      t.subjectKind,
      t.subjectId,
      t.typeId,
    ),
    index("hrm_qualification_requirements_org_subject").on(
      t.orgId,
      t.subjectKind,
      t.subjectId,
    ),
    check(
      "hrm_qualification_requirements_window",
      sql`${t.requiredTo} is null or ${t.requiredTo} >= ${t.requiredFrom}`,
    ),
  ],
);

/** Qualification alerts (0225): one row per (qualification, lead_days). */
export const hrmQualificationAlerts = pgTable(
  "hrm_qualification_alerts",
  {
    id: id(),
    orgId: orgRef(),
    qualificationId: uuid("qualification_id").notNull(),
    leadDays: integer("lead_days").notNull(),
    dueOn: date("due_on").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    channel: text("channel", { enum: HRM_QUALIFICATION_ALERT_CHANNELS })
      .notNull()
      .default("inbox"),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_qualification_alerts_qualification_fkey",
      columns: [t.orgId, t.qualificationId],
      foreignColumns: [hrmWorkerQualifications.orgId, hrmWorkerQualifications.id],
    }),
    uniqueIndex("hrm_qualification_alerts_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_qualification_alerts_qualification_lead_unique").on(
      t.qualificationId,
      t.leadDays,
    ),
    index("hrm_qualification_alerts_org_due").on(t.orgId, t.dueOn),
    check("hrm_qualification_alerts_lead_days", sql`${t.leadDays} > 0`),
  ],
);

/** Qualification settings (0225): org vocabulary + alert schedule. */
export const hrmQualificationSettings = pgTable(
  "hrm_qualification_settings",
  {
    orgId: uuid("org_id").primaryKey(),
    extraCategories: text("extra_categories")
      .array()
      .notNull()
      .default(sql`'{}'`),
    alertLeadDays: integer("alert_lead_days")
      .array()
      .notNull()
      .default(sql`'{30,14,7,1}'`),
    ...auditColumns,
  },
  (t) => [
    check(
      "hrm_qualification_settings_lead_days",
      sql`array_length(${t.alertLeadDays}, 1) is not null`,
    ),
  ],
);
