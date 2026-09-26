import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid
} from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";
export const CRM_ACTIVITY_KINDS = ["task", "call", "event", "email", "note"] as const;
export const CRM_ACTIVITY_STATUSES = ["planned", "in_progress", "completed", "cancelled"] as const;

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
