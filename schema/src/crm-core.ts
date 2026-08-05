import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, money, orgRef } from "./helpers";

export const CRM_LIFECYCLE_STAGES = ["lead", "prospect", "customer"] as const;
export const CRM_ACTIVITY_KINDS = ["task", "call", "event", "email", "note"] as const;
export const CRM_ACTIVITY_STATUSES = ["planned", "in_progress", "completed", "cancelled"] as const;

/** Tenant-configurable statuses for each relationship lifecycle stage. */
export const crmAccountStatuses = pgTable(
  "crm_account_statuses",
  {
    id: id(),
    orgId: orgRef(),
    lifecycleStage: text("lifecycle_stage", { enum: CRM_LIFECYCLE_STAGES }).notNull(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    sequence: integer("sequence").notNull().default(0),
    isQualified: boolean("is_qualified").notNull().default(false),
    isClosed: boolean("is_closed").notNull().default(false),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("crm_account_statuses_org_stage_key").on(t.orgId, t.lifecycleStage, t.key),
    index("crm_account_statuses_org_stage").on(t.orgId, t.lifecycleStage, t.sequence),
  ],
);

/** Normalized lead sources used by accounts, opportunities, and documents. */
export const crmLeadSources = pgTable(
  "crm_lead_sources",
  {
    id: id(),
    orgId: orgRef(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    parentId: uuid("parent_id"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [uniqueIndex("crm_lead_sources_org_key").on(t.orgId, t.key)],
);

export type CrmTerritoryRule = {
  field: "country" | "region" | "industry" | "lifecycleStage" | "leadSourceId" | "annualRevenue" | "employeeCount";
  operator: "equals" | "in" | "contains" | "gte" | "lte";
  value: string | string[] | number;
};

/** Prioritized, deterministic account-routing territories. */
export const crmSalesTerritories = pgTable(
  "crm_sales_territories",
  {
    id: id(),
    orgId: orgRef(),
    parentId: uuid("parent_id"),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    priority: integer("priority").notNull().default(100),
    managerUserId: uuid("manager_user_id"),
    defaultOwnerUserId: uuid("default_owner_user_id"),
    matchMode: text("match_mode", { enum: ["all", "any"] }).notNull().default("all"),
    rules: jsonb("rules").$type<CrmTerritoryRule[]>().notNull().default([]),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("crm_sales_territories_org_key").on(t.orgId, t.key),
    index("crm_sales_territories_routing").on(t.orgId, t.isActive, t.priority),
  ],
);

/** CRM state layered over the canonical party identity. */
export const crmAccountProfiles = pgTable(
  "crm_account_profiles",
  {
    id: id(),
    orgId: orgRef(),
    partyId: uuid("party_id").notNull(),
    lifecycleStage: text("lifecycle_stage", { enum: CRM_LIFECYCLE_STAGES }).notNull().default("lead"),
    statusId: uuid("status_id"),
    ownerUserId: uuid("owner_user_id"),
    territoryId: uuid("territory_id"),
    leadSourceId: uuid("lead_source_id"),
    industry: text("industry"),
    category: text("category"),
    annualRevenue: money("annual_revenue"),
    employeeCount: integer("employee_count"),
    qualificationScore: integer("qualification_score"),
    qualification: jsonb("qualification").$type<Record<string, unknown>>().notNull().default({}),
    nextActionAt: timestamp("next_action_at", { withTimezone: true }),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
    qualifiedAt: timestamp("qualified_at", { withTimezone: true }),
    convertedAt: timestamp("converted_at", { withTimezone: true }),
    acquiredOn: date("acquired_on"),
    isActive: boolean("is_active").notNull().default(true),
    custom: jsonb("custom").notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("crm_account_profiles_party").on(t.partyId),
    index("crm_account_profiles_stage_owner").on(t.orgId, t.lifecycleStage, t.ownerUserId),
    index("crm_account_profiles_territory").on(t.orgId, t.territoryId),
    check("crm_account_qualification_score", sql`${t.qualificationScore} is null or (${t.qualificationScore} >= 0 and ${t.qualificationScore} <= 100)`),
    check("crm_account_employee_count", sql`${t.employeeCount} is null or ${t.employeeCount} >= 0`),
  ],
);

/** Immutable evidence for automatic and manual lifecycle changes. */
export const crmAccountStageEvents = pgTable(
  "crm_account_stage_events",
  {
    id: id(),
    orgId: orgRef(),
    accountProfileId: uuid("account_profile_id").notNull(),
    fromStage: text("from_stage", { enum: CRM_LIFECYCLE_STAGES }),
    toStage: text("to_stage", { enum: CRM_LIFECYCLE_STAGES }).notNull(),
    sourceKind: text("source_kind").notNull().default("manual"),
    sourceId: uuid("source_id"),
    reason: text("reason"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    ...auditColumns,
  },
  (t) => [index("crm_account_stage_events_profile").on(t.accountProfileId, t.occurredAt)],
);

/** Ownership and territory changes survive later reassignment. */
export const crmAccountAssignmentEvents = pgTable(
  "crm_account_assignment_events",
  {
    id: id(),
    orgId: orgRef(),
    accountProfileId: uuid("account_profile_id").notNull(),
    fromOwnerUserId: uuid("from_owner_user_id"),
    toOwnerUserId: uuid("to_owner_user_id"),
    fromTerritoryId: uuid("from_territory_id"),
    toTerritoryId: uuid("to_territory_id"),
    source: text("source", { enum: ["manual", "routing", "import", "flow"] }).notNull(),
    reason: text("reason"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    ...auditColumns,
  },
  (t) => [index("crm_account_assignment_events_profile").on(t.accountProfileId, t.occurredAt)],
);

/** One activity model for tasks, calls, meetings, email, and notes. */
export const crmActivities = pgTable(
  "crm_activities",
  {
    id: id(),
    orgId: orgRef(),
    kind: text("kind", { enum: CRM_ACTIVITY_KINDS }).notNull(),
    status: text("status", { enum: CRM_ACTIVITY_STATUSES }).notNull().default("planned"),
    subject: text("subject").notNull(),
    body: text("body"),
    priority: text("priority", { enum: ["low", "normal", "high", "urgent"] }).notNull().default("normal"),
    ownerUserId: uuid("owner_user_id"),
    assignedUserId: uuid("assigned_user_id"),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    dueAt: timestamp("due_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    reminderAt: timestamp("reminder_at", { withTimezone: true }),
    durationMinutes: integer("duration_minutes"),
    recurrence: jsonb("recurrence").$type<Record<string, unknown>>(),
    isPrivate: boolean("is_private").notNull().default(false),
    custom: jsonb("custom").notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    index("crm_activities_assignee").on(t.orgId, t.assignedUserId, t.status, t.dueAt),
    index("crm_activities_calendar").on(t.orgId, t.startsAt, t.endsAt),
    check("crm_activity_duration", sql`${t.durationMinutes} is null or ${t.durationMinutes} >= 0`),
    check("crm_activity_dates", sql`${t.endsAt} is null or ${t.startsAt} is null or ${t.endsAt} >= ${t.startsAt}`),
  ],
);

/** Polymorphic links let one activity appear on every relevant record. */
export const crmActivityLinks = pgTable(
  "crm_activity_links",
  {
    id: id(),
    orgId: orgRef(),
    activityId: uuid("activity_id").notNull(),
    subjectKind: text("subject_kind").notNull(),
    subjectId: uuid("subject_id").notNull(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("crm_activity_links_unique").on(t.activityId, t.subjectKind, t.subjectId),
    index("crm_activity_links_subject").on(t.orgId, t.subjectKind, t.subjectId),
  ],
);

/** Internal/external participants for meetings, calls, and email activity. */
export const crmActivityParticipants = pgTable(
  "crm_activity_participants",
  {
    id: id(),
    orgId: orgRef(),
    activityId: uuid("activity_id").notNull(),
    userId: uuid("user_id"),
    contactId: uuid("contact_id"),
    email: text("email"),
    response: text("response", { enum: ["none", "accepted", "declined", "tentative"] }).notNull().default("none"),
    ...auditColumns,
  },
  (t) => [
    index("crm_activity_participants_activity").on(t.activityId),
    check("crm_activity_participant_target", sql`num_nonnulls(${t.userId}, ${t.contactId}, ${t.email}) = 1`),
  ],
);

/*
FOREIGN KEYS live in schema/migrations/referential-integrity.sql.
*/
