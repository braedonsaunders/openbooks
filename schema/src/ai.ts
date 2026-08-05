import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, money, orgRef } from "./helpers";

/**
 * AI assistant conversation history. The ai_conversations/ai_messages pair
 * stores private per-user conversations. `scope` namespaces threads per feature
 * ('assistant' for the
 * overview chat) so future features (report explanations, drawer copilots)
 * can reuse the same tables.
 */

export const aiConversations = pgTable(
  "ai_conversations",
  {
    id: id(),
    orgId: orgRef(),
    /** Owner — the only user who can read, continue, or delete the thread. */
    userId: uuid("user_id").notNull(),
    scope: text("scope").notNull().default("assistant"),
    title: text("title").notNull().default("New chat"),
    ...auditColumns,
  },
  (t) => [
    index("ai_conversations_owner_scope").on(t.orgId, t.userId, t.scope, t.updatedAt),
  ],
);

export const aiMessages = pgTable(
  "ai_messages",
  {
    id: id(),
    orgId: orgRef(),
    conversationId: uuid("conversation_id").notNull(),
    role: text("role", { enum: ["user", "assistant", "system"] }).notNull(),
    /** Plain-text rendering of the turn (used as the model-window fallback). */
    content: text("content").notNull(),
    /**
     * Structured agent-turn payload: `{ v, kind, status, finishReason, usage,
     * parts }` where `parts` is the UI-message parts array (text + tool calls)
     * the chat re-renders on reload exactly as it streamed live.
     */
    data: jsonb("data").$type<Record<string, unknown> | null>(),
    ...auditColumns,
  },
  (t) => [index("ai_messages_conversation").on(t.conversationId, t.createdAt)],
);

/**
 * Tenant policy for each built-in operational agent. Provider/model secrets
 * remain on orgs.settings.ai; these rows control whether an agent may run,
 * whether the scheduler invokes it, and the materiality floor its detectors
 * use. An absent row means disabled (fail closed).
 */
export const aiAgentPolicies = pgTable(
  "ai_agent_policies",
  {
    id: id(),
    orgId: orgRef(),
    agentKey: text("agent_key", { enum: ["accounting", "finance"] }).notNull(),
    enabled: boolean("enabled").notNull().default(false),
    automaticRuns: boolean("automatic_runs").notNull().default(false),
    cadence: text("cadence", { enum: ["daily", "weekly"] }).notNull().default("daily"),
    materialityThreshold: money("materiality_threshold").notNull().default("1000"),
    /** Canonical per-detector enablement, materiality overrides, and thresholds. */
    detectorSettings: jsonb("detector_settings").$type<Record<string, unknown>>().notNull().default({}),
    /** Tenant controls for tool-using analysis, recommendations, and narratives. */
    analysisSettings: jsonb("analysis_settings").$type<Record<string, unknown>>().notNull().default({}),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("ai_agent_policies_org_agent").on(t.orgId, t.agentKey),
    index("ai_agent_policies_due").on(t.enabled, t.automaticRuns, t.nextRunAt),
  ],
);

/** One immutable execution envelope for a manual or scheduled agent scan. */
export const aiAgentRuns = pgTable(
  "ai_agent_runs",
  {
    id: id(),
    orgId: orgRef(),
    agentKey: text("agent_key", { enum: ["accounting", "finance"] }).notNull(),
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

/**
 * A deduplicated, reviewable unit of work produced by an agent detector.
 * `fingerprint` is stable for the underlying condition (for example, one bank
 * account with unmatched activity), allowing scans to refresh, reopen, or
 * automatically resolve the same finding without flooding the work queue.
 */
export const aiWorkItems = pgTable(
  "ai_work_items",
  {
    id: id(),
    orgId: orgRef(),
    agentKey: text("agent_key", { enum: ["accounting", "finance"] }).notNull(),
    findingType: text("finding_type").notNull(),
    detectorVersion: text("detector_version").notNull(),
    fingerprint: text("fingerprint").notNull(),
    severity: text("severity", { enum: ["info", "warning", "critical"] }).notNull(),
    status: text("status", { enum: ["open", "in_review", "resolved", "dismissed"] })
      .notNull()
      .default("open"),
    confidence: money("confidence").notNull().default("1"),
    materiality: money("materiality").notNull().default("0"),
    subjectType: text("subject_type"),
    subjectId: uuid("subject_id"),
    summary: jsonb("summary").$type<Record<string, unknown>>().notNull().default({}),
    firstDetectedAt: timestamp("first_detected_at", { withTimezone: true }).notNull().defaultNow(),
    lastDetectedAt: timestamp("last_detected_at", { withTimezone: true }).notNull().defaultNow(),
    lastDetectedRunId: uuid("last_detected_run_id"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by"),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    dismissedBy: uuid("dismissed_by"),
    dismissalReason: text("dismissal_reason"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("ai_work_items_org_fingerprint").on(t.orgId, t.agentKey, t.fingerprint),
    index("ai_work_items_org_status_seen").on(t.orgId, t.status, t.lastDetectedAt),
    index("ai_work_items_agent_status").on(t.orgId, t.agentKey, t.status),
  ],
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

/** Per-user usefulness feedback, retained for detector evaluation. */
export const aiWorkItemFeedback = pgTable(
  "ai_work_item_feedback",
  {
    id: id(),
    orgId: orgRef(),
    workItemId: uuid("work_item_id").notNull(),
    userId: uuid("user_id").notNull(),
    rating: text("rating", { enum: ["helpful", "not_helpful"] }).notNull(),
    comment: text("comment"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ai_work_item_feedback_user").on(t.workItemId, t.userId),
    index("ai_work_item_feedback_org").on(t.orgId, t.createdAt),
  ],
);
