import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

/**
 * Flows — visual graph automation (the flow execution contract). A flow is an
 * authored node graph (trigger → conditions → actions → gates) over a subject
 * kind (a document kind like 'vendor_bill', or a module key). Runs are
 * checkpointed: every completed action writes a flow_run_effects row, so
 * re-execution after a failure resumes instead of double-firing. Gate nodes
 * pause the run as flow_gates rows (the human-approval worklist), and
 * notifications is the in-app inbox the `notify` action (and gate
 * reminders/escalations) write to.
 *
 * Flows own approvals outright: a submit fires the record's on_submit flows
 * (engine/src/flows/submit.ts), and a flow that produces gates flips the
 * document to pending_approval. There is no separate approval engine.
 *
 *   flows
 *     ├─ flow_scheduled_occurrences (per-occurrence durability ledger for
 *     │                              scheduled triggers; crash-resumable claims)
 *     └─ flow_runs            (one per trigger firing; run history)
 *          ├─ flow_run_effects (idempotency checkpoints)
 *          └─ flow_gates       (paused human approvals; quorum any/all)
 *   notifications             (per-user in-app inbox, subject-agnostic)
 */

export const FLOW_RUN_STATUSES = [
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
] as const;

export const FLOW_GATE_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "cancelled",
  "escalated",
] as const;

export const FLOW_GATE_QUORUMS = ["any", "all"] as const;

export const FLOW_SCHEDULED_OCCURRENCE_STATUSES = [
  "open",
  "firing",
  "fired",
  "lost",
] as const;

export const flows = pgTable(
  "flows",
  {
    id: id(),
    orgId: orgRef(),
    name: text("name").notNull().default("Flow"),
    description: text("description"),
    /** What the flow runs over: a document kind ('vendor_bill', …) or a module key. */
    subjectKind: text("subject_kind").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /**
     * The AutomationGraph (packages/forms-core automation.ts): nodes
     * (trigger/condition/action/gate) + edges with next|then|else|approve|reject
     * handles. Typed loosely here to keep the schema package free of
     * forms-core imports; validated by the zod graph schema on every write.
     */
    graph: jsonb("graph").$type<Record<string, unknown>>().notNull(),
    /**
     * Last time the scheduler fired this flow's `scheduled` trigger — dedups
     * the every-minute scan so a cron only runs once per matching minute.
     */
    lastScheduledRunAt: timestamp("last_scheduled_run_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [index("flows_org_subject").on(t.orgId, t.subjectKind, t.enabled)],
);

/**
 * One row per trigger firing. Gates flip
 * status to 'waiting'; a satisfied quorum resumes the approve/reject branch.
 */
export const flowRuns = pgTable(
  "flow_runs",
  {
    id: id(),
    orgId: orgRef(),
    flowId: uuid("flow_id").notNull(),
    subjectKind: text("subject_kind").notNull(),
    subjectId: uuid("subject_id").notNull(),
    /** The trigger kind that fired: 'on_submit', 'scheduled', 'manual', … */
    trigger: text("trigger").notNull(),
    status: text("status", { enum: FLOW_RUN_STATUSES }).notNull().default("running"),
    error: text("error"),
    /** Snapshot of the evaluation values (record fields, …) at run start. */
    context: jsonb("context").$type<Record<string, unknown>>().notNull().default({}),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /**
     * Deterministic retry identity for scheduled firings:
     * `sched|<flowId>|<nodeId>|<occurredAt ISO>|<subjectId>`. A resumed
     * occurrence adopts the row that already carries its key — effect
     * checkpoints and email deferrals are keyed off the run id, so a retry
     * can never double-send. Set only by the scheduled runner; unique when
     * present (migration 0052).
     */
    occurrenceKey: text("occurrence_key"),
    ...auditColumns,
  },
  (t) => [
    index("flow_runs_org_flow").on(t.orgId, t.flowId),
    index("flow_runs_subject").on(t.orgId, t.subjectKind, t.subjectId),
    index("flow_runs_status").on(t.orgId, t.status),
  ],
);

/**
 * Idempotency checkpoints: every completed action/gate writes one row keyed
 * `${flowId}:action:${nodeId}` — re-executing a failed run skips effects that
 * already completed instead of double-sending emails or re-posting.
 */
export const flowRunEffects = pgTable(
  "flow_run_effects",
  {
    id: id(),
    orgId: orgRef(),
    runId: uuid("run_id").notNull(),
    effectKey: text("effect_key").notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow(),
    ...auditColumns,
  },
  (t) => [uniqueIndex("flow_run_effects_run_effect").on(t.runId, t.effectKey)],
);

/**
 * Paused human approvals — one row per (gate node instance × assignee). A
 * gate node with multiple assignees spawns sibling rows sharing a groupKey;
 * quorum 'any' resumes on the first decision, 'all' when every sibling
 * approves. Deciding is an atomic conditional UPDATE (pending → decided) so a
 * gate can never double-fire.
 */
export const flowGates = pgTable(
  "flow_gates",
  {
    id: id(),
    orgId: orgRef(),
    flowId: uuid("flow_id").notNull(),
    runId: uuid("run_id").notNull(),
    /** The gate node in the flow's graph this row paused on. */
    nodeId: text("node_id").notNull(),
    subjectKind: text("subject_kind").notNull(),
    subjectId: uuid("subject_id").notNull(),
    title: text("title").notNull(),
    /** Resolved assignee: a user… */
    assigneeUserId: uuid("assignee_user_id"),
    /** …or a role (any holder may act). */
    assigneeRole: text("assignee_role"),
    /** Same for all sibling rows of one gate node instance: `${runId}:${nodeId}`. */
    groupKey: text("group_key").notNull(),
    quorum: text("quorum", { enum: FLOW_GATE_QUORUMS }).notNull().default("any"),
    status: text("status", { enum: FLOW_GATE_STATUSES }).notNull().default("pending"),
    signatureRequired: boolean("signature_required").notNull().default(false),
    /** Typed e-signature captured when a signature-required gate is approved. */
    signature: text("signature"),
    comment: text("comment"),
    decidedBy: uuid("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /**
     * Structured delegation provenance (a financial audit can't rely on parsed
     * free text). Set when delegateGate reassigns this row: the original
     * assignee it was handed off FROM (preserved even after the row is decided).
     */
    delegatedFromUserId: uuid("delegated_from_user_id"),
    /**
     * The principal a delegate decided ON BEHALF OF (out-of-office coverage).
     * decidedBy stays the actual decider; this records whose gate it was.
     */
    onBehalfOfUserId: uuid("on_behalf_of_user_id"),
    /** Reminder / escalation cursors, scanned by the 60s scheduler tick. */
    remindAt: timestamp("remind_at", { withTimezone: true }),
    escalateAt: timestamp("escalate_at", { withTimezone: true }),
    remindedAt: timestamp("reminded_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    // Idempotent gate creation: replaying a run can't spawn duplicate rows.
    uniqueIndex("flow_gates_run_node_assignee").on(t.runId, t.nodeId, t.assigneeUserId),
    index("flow_gates_assignee").on(t.orgId, t.status, t.assigneeUserId),
    index("flow_gates_subject").on(t.orgId, t.subjectKind, t.subjectId),
    index("flow_gates_remind").on(t.orgId, t.status, t.remindAt),
  ],
);

/**
 * Out-of-office approval delegation (source platform "approval delegate" parity,
 * date-ranged). While now() is between startsAt/endsAt and the row is not
 * revoked, `toUserId` may see and decide `fromUserId`'s pending flow gates —
 * on behalf of the principal, never with more authority than the principal's
 * gate assignment grants. Decisions record decidedBy = the delegate with an
 * on-behalf-of note on the gate's comment (audit survives revocation).
 */
export const approvalDelegations = pgTable(
  "approval_delegations",
  {
    id: id(),
    orgId: orgRef(),
    /** The principal handing off their approvals (out of office). */
    fromUserId: uuid("from_user_id").notNull(),
    /** The delegate who may act on the principal's gates in the window. */
    toUserId: uuid("to_user_id").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    reason: text("reason"),
    /** Early cancellation — a revoked delegation is inert but kept for audit. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    index("approval_delegations_from").on(t.orgId, t.fromUserId, t.endsAt),
    index("approval_delegations_to").on(t.orgId, t.toUserId, t.endsAt),
  ],
);

/**
 * Flow-managed record locks — the `lock_record` action (source platform "Lock
 * Record" with role exemptions). While a row exists the record rejects
 * edits/void/delete for everyone except admins and holders of an exemptRole;
 * `unlock_record` removes it. One lock per record (the unique index): a
 * second lock_record replaces the reason/exemptions. Locks deliberately
 * survive status changes (source platform's donotexitworkflow terminal locks — e.g.
 * an approved vendor payment stays locked forever).
 */
export const flowLocks = pgTable(
  "flow_locks",
  {
    id: id(),
    orgId: orgRef(),
    subjectKind: text("subject_kind").notNull(),
    subjectId: uuid("subject_id").notNull(),
    /** The flow whose lock_record action created this lock. */
    flowId: uuid("flow_id").notNull(),
    reason: text("reason"),
    /** Role keys allowed through in addition to admins. */
    exemptRoles: jsonb("exempt_roles").$type<string[]>().notNull().default([]),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("flow_locks_subject").on(t.subjectKind, t.subjectId),
    index("flow_locks_org").on(t.orgId, t.subjectKind),
  ],
);

/**
 * In-app inbox (new to openbooks). Written by the flows `notify` action, gate
 * assignment/reminder/escalation, and anything else that wants a bell-menu
 * entry. readAt null = unread.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    orgId: orgRef(),
    userId: uuid("user_id").notNull(),
    /** Category for filtering/icons: 'approval', 'flow', 'general', … */
    kind: text("kind").notNull().default("general"),
    title: text("title").notNull(),
    body: text("body"),
    /** In-app link the notification opens, e.g. '/approvals'. */
    href: text("href"),
    readAt: timestamp("read_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    index("notifications_user_inbox").on(t.orgId, t.userId, t.readAt),
    index("notifications_user_created").on(t.userId, t.createdAt),
  ],
);

/**
 * Per-occurrence durability ledger for scheduled flows (one row per flow ×
 * scheduled trigger node × cron occurrence). The claim commits atomically
 * WITH the last_scheduled_run_at cursor advance, so a crash between claiming
 * and firing leaves the occurrence recoverable instead of lost:
 *
 *   CLAIM   — INSERT … ON CONFLICT DO NOTHING alongside the cursor CTE; only
 *             rows the scanner itself inserted are fired.
 *   FIRE    — a bounded-attempt attempt takes the open claim ('open' →
 *             'firing'), runs the fan-out, and closes 'fired' inside the
 *             same tenant transaction as the runs/effects/outbox emails it
 *             produced — delivery and completion commit or roll back together.
 *   RECOVER — claims stuck 'firing' past the stale window resume by
 *             occurrence key (same flow_runs rows → no double-send), with a
 *             visible terminal 'lost' after the retry budget is spent.
 */
export const flowScheduledOccurrences = pgTable(
  "flow_scheduled_occurrences",
  {
    id: id(),
    orgId: orgRef(),
    flowId: uuid("flow_id").notNull(),
    /** The scheduled trigger node in the flow's graph this claim names. */
    nodeId: text("node_id").notNull(),
    /** The cron occurrence this firing covers (the cursor value it claimed). */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    status: text("status", { enum: FLOW_SCHEDULED_OCCURRENCE_STATUSES })
      .notNull()
      .default("open"),
    /** Number of firings started against this claim (initial + recovery retries). */
    attemptCount: integer("attempt_count").notNull().default(0),
    result: jsonb("result").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("flow_scheduled_occurrences_once").on(t.flowId, t.nodeId, t.occurredAt),
    index("flow_scheduled_occurrences_recovery").on(t.status, t.updatedAt),
  ],
);

/*
FOREIGN KEYS (added by the integrator's migration pass to
schema/migrations/referential-integrity.sql):
  flows.org_id                  → orgs.id (on delete cascade)
  flow_runs.org_id              → orgs.id (on delete cascade)
  flow_runs.flow_id             → flows.id (on delete cascade)
  flow_run_effects.org_id       → orgs.id (on delete cascade)
  flow_run_effects.run_id       → flow_runs.id (on delete cascade)
  flow_gates.org_id             → orgs.id (on delete cascade)
  flow_gates.flow_id            → flows.id (on delete cascade)
  flow_gates.run_id             → flow_runs.id (on delete cascade)
  flow_gates.assignee_user_id   → users.id
  flow_gates.decided_by         → users.id
  approval_delegations.org_id       → orgs.id (on delete cascade)
  approval_delegations.from_user_id → users.id
  approval_delegations.to_user_id   → users.id
  flow_locks.org_id             → orgs.id (on delete cascade)
  flow_locks.flow_id            → flows.id (on delete cascade)
  notifications.org_id          → orgs.id (on delete cascade)
  notifications.user_id         → users.id (on delete cascade)
  flow_scheduled_occurrences.org_id  → orgs.id
  flow_scheduled_occurrences.flow_id → flows.id (on delete cascade)
*/
