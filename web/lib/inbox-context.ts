import "server-only";
import { countInbox, type InboxKind, type InboxListContext, type InboxSourceNotice } from "@openbooks/engine/src/inbox/index.ts";
import { businessToday } from "@openbooks/engine/src/platform/business-date.ts";
import { can, type Authz } from "./authz";
import { isFeatureEnabled } from "./features";

/**
 * HR-15: build the server-side inbox context from the session. The union
 * scope (roles, subsidiary boundary, budget leg) rides the
 * context so the flows leg sees exactly the gates the inbox page's union
 * table shows. Built only from the session — never from client input.
 */
export async function inboxContext(authz: Authz): Promise<InboxListContext> {
  const orgId = authz.user.orgId;
  const [asOf, budgetsOn] = await Promise.all([
    businessToday(orgId),
    isFeatureEnabled(orgId, "budgets"),
  ]);
  return {
    orgId,
    actorId: authz.user.id,
    asOf,
    scope: {
      roles: authz.user.roles.map((role) => role.key),
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds === null ? null : [...authz.allowedSubsidiaryIds],
      includeBudgets: budgetsOn && can(authz, "budgets.approve"),
    },
  };
}

/**
 * Wire view for degraded source legs. Notices are sanitized where
 * they are recorded (the engine names only designed refusals, everything
 * else carries a generic reason), so mapping them here keeps raw `.message`
 * text out of API route bodies entirely.
 */
export function toInboxNoticeViews(notices: InboxSourceNotice[]): { source: InboxKind; reason: string }[] {
  return notices.map((notice) => ({ source: notice.kind, reason: notice.message }));
}

/** The doorway to decision rows lives in ./approval-doorway; re-exported for inbox callers. */
import { maySeeUnion } from "./approval-doorway";
export { maySeeUnion };

export const INBOX_FILTER_KINDS: Record<string, InboxKind[]> = {
  approvals: ["flows_approval", "expense_report"],
  my_tasks: [
    "hrm_process_step",
    "hrm_leave_request",
    "hrm_change_request",
    "hrm_review",
    "hrm_benefit_enrollment_window",
    "hrm_qualification_alert",
    "timesheet_week",
    // HR-21: blocking payroll checks (payroll managers) and overdue AI
    // capability reviews (ledger admins) — no actions; the work happens
    // in the checks queue and the ledger behind the subject hrefs.
    "payroll_anomaly_block",
    "ai_capability_review",
  ],
  signatures: ["field_ticket_signature", "document_signature"],
  notices: ["notification"],
};

/** Every kind the task list may render (union-owned kinds excluded). */
export const INBOX_TASK_KINDS: InboxKind[] = [
  ...INBOX_FILTER_KINDS.my_tasks!,
  ...INBOX_FILTER_KINDS.signatures!,
  ...INBOX_FILTER_KINDS.notices!,
];

/** Unfiltered personal work totals shared by navigation, Inbox and Home.
 * Count each source rather than a bounded list window. The badge totals the
 * My Approvals and My Tasks tabs, independent of the active tab or filters. */
export async function inboxCounts(authz: Authz, ctx: InboxListContext) {
  const notices: InboxSourceNotice[] = [];
  const [approvals, tasks] = await Promise.all([
    maySeeUnion(authz)
      ? import("./application/approvals").then(({ approvalWorklistCountForAuthz }) => approvalWorklistCountForAuthz(authz))
      : Promise.resolve(0),
    countInbox(ctx, { kinds: INBOX_TASK_KINDS, notices }),
  ]);
  return { approvals, tasks, count: approvals + tasks, notices };
}
