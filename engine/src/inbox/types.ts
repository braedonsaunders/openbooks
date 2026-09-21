/**
 * HR-15 inbox read model — shared vocabulary.
 *
 * An InboxItem is a stable, derived pointer at work waiting on the actor:
 * the id is `kind:sourceId` so two calls with the same inputs return the
 * same list, and acting twice on the same item is idempotent by construction
 * (the second act re-resolves the source, which refuses the stale item by
 * name). Items are computed live from the sources on every read — there is
 * no materialized copy to drift.
 */

import type { SqlExecutor } from "../platform/db.ts";

/** Sort bucket: overdue first, then due soon, then everything else. */
export type InboxPriority = "overdue" | "due_soon" | "normal";

/** Every source kind the inbox aggregates. Registered in registry.ts. */
export type InboxKind =
  | "flows_approval"
  | "hrm_process_step"
  | "hrm_leave_request"
  | "hrm_change_request"
  | "hrm_review"
  | "hrm_feedback_request"
  | "hrm_benefit_enrollment_window"
  | "hrm_qualification_alert"
  | "field_ticket_signature"
  | "timesheet_week"
  // HR-20 begin
  | "crew_time_batch"
  // HR-20 end
  | "expense_report"
  | "notification"
  | "document_signature"
  | "payroll_anomaly_block"
  | "ai_capability_review";

export type InboxActionStyle = "primary" | "secondary" | "danger";

export interface InboxActionDef {
  readonly key: string;
  readonly label: string;
  readonly style: InboxActionStyle;
  /** True when the source refuses the action without a reason (reject, delegate). */
  readonly needsReason: boolean;
}

export interface InboxItem {
  /** Stable: `${kind}:${sourceId}`. */
  readonly id: string;
  readonly kind: InboxKind;
  readonly title: string;
  readonly subtitle: string | null;
  readonly dueAt: string | null;
  readonly createdAt: string;
  readonly priority: InboxPriority;
  readonly subjectHref: string;
  readonly actions: readonly InboxActionDef[];
  readonly source: { readonly kind: string; readonly id: string };
}

export interface InboxListContext {
  readonly orgId: string;
  readonly actorId: string;
  readonly asOf: string;
  /**
   * HR-20: injectable executor for the feature-off bypass proof — a test
   * double that throws when a gated table is reached. Absent means the
   * pooled handle; production callers never set this.
   */
  readonly exec?: SqlExecutor;
  /**
   * Authz-derived union scope for the flows leg (roles, subsidiary
   * boundary, budget/pay-run legs). Built by web callers from the session;
   * absent means flows legs only with no subsidiary restriction beyond the
   * reader's own gates. Never trust client input here — only the session.
   */
  readonly scope?: {
    readonly roles?: readonly string[];
    readonly allowedSubsidiaryIds?: readonly string[] | null;
    readonly includeBudgets?: boolean;
    readonly includePayRuns?: boolean;
    readonly payDirections?: readonly string[];
  };
}

/** Priority from an optional due date relative to asOf (day-granular). */
export function priorityForDueDate(dueAt: string | null, asOf: string): InboxPriority {
  if (!dueAt) return "normal";
  const dueDay = dueAt.slice(0, 10);
  const today = asOf.slice(0, 10);
  if (dueDay < today) return "overdue";
  const soon = new Date(`${today}T00:00:00Z`).getTime() + 3 * 24 * 3600 * 1000;
  if (new Date(`${dueDay}T00:00:00Z`).getTime() <= soon) return "due_soon";
  return "normal";
}

/** Merge order: overdue → due soon → newest first, then stable id order. */
export function compareInboxItems(a: InboxItem, b: InboxItem): number {
  const rank = (p: InboxPriority): number => (p === "overdue" ? 0 : p === "due_soon" ? 1 : 2);
  return (
    rank(a.priority) - rank(b.priority) ||
    (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

export function inboxItemId(kind: InboxKind, sourceId: string): string {
  return `${kind}:${sourceId}`;
}

/** Split a `kind:sourceId` item id back into its source pointer. */
export function parseInboxItemId(itemId: string): { kind: string; sourceId: string } | null {
  const sep = itemId.indexOf(":");
  if (sep < 0) return null;
  const kind = itemId.slice(0, sep);
  const sourceId = itemId.slice(sep + 1);
  if (!kind || !sourceId) return null;
  return { kind, sourceId };
}
