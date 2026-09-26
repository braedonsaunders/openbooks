import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid
} from "drizzle-orm/pg-core";
import { id, orgRef } from "./helpers";

/** One immutable execution envelope for a manual or scheduled agent scan. */
export const aiAgentRuns = pgTable(
  "ai_agent_runs",
  {
    id: id(),
    orgId: orgRef(),
    agentKey: text("agent_key", { enum: ["accounting", "finance", "collections", "payables", "reconciliation", "hygiene", "forensics", "tax", "payroll", "projects", "cash"] }).notNull(),
    trigger: text("trigger", { enum: ["manual", "scheduler"] }).notNull(),
    status: text("status", { enum: ["running", "completed", "failed", "skipped"] })
      .notNull()
      .default("running"),
    detectorVersion: text("detector_version").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    initiatedBy: uuid("initiated_by"),
    stats: jsonb("stats").$type<Record<string, unknown>>().notNull().default({}),
    errorCode: text("error_code"),
  },
  (t) => [index("ai_agent_runs_org_started").on(t.orgId, t.startedAt)],
);

/** Source records and metric snapshots supporting a work item conclusion. */
export const aiWorkItemEvidence = pgTable(
  "ai_work_item_evidence",
  {
    id: id(),
    orgId: orgRef(),
    workItemId: uuid("work_item_id").notNull(),
    kind: text("kind").notNull(),
    sourceType: text("source_type"),
    sourceId: uuid("source_id"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ai_work_item_evidence_item").on(t.workItemId, t.createdAt)],
);
