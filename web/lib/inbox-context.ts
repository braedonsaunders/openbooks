import "server-only";
import { countInbox, listInbox, type InboxItem, type InboxKind, type InboxListContext, type InboxSourceNotice } from "@openbooks/engine/src/inbox/index.ts";
import { businessTimeZone, businessToday } from "@openbooks/engine/src/platform/business-date.ts";
import { approveSubmittedTimeEntries } from "./time-approval";
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
  const [asOf, timeZone, budgetsOn] = await Promise.all([
    businessToday(orgId),
    businessTimeZone(orgId),
    isFeatureEnabled(orgId, "budgets"),
  ]);
  return {
    orgId,
    actorId: authz.user.id,
    asOf,
    timeZone,
    scope: {
      roles: authz.user.roles.map((role) => role.key),
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds === null ? null : [...authz.allowedSubsidiaryIds],
      includeBudgets: budgetsOn && can(authz, "budgets.approve"),
    },
    // Direct timesheet-week approval executes the native approval service —
    // the same command the drawer runs — so the inbox never grows a second
    // write path. Scope rides the session, exactly as the approve route's.
    approveTimesheetWeek: async ({ employeePartyId, weekStart }) => {
      await approveSubmittedTimeEntries({
        orgId,
        actorId: authz.user.id,
        employeePartyId,
        weekStart,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      });
    },
  };
}

/**
 * Wire view for degraded source legs. Notices are sanitized where
 * they are recorded (the engine names only designed refusals, everything
 * else carries a generic reason), so mapping them here keeps raw `.message`
 * text out of API route bodies entirely.
 */
export function toInboxNoticeViews(notices: InboxSourceNotice[]): { source: InboxKind; code: InboxSourceNotice["code"]; reason: string }[] {
  return notices.map((notice) => ({ source: notice.kind, code: notice.code, reason: notice.message }));
}

/** The doorway to decision rows lives in ./approval-doorway; re-exported for inbox callers. */
import { maySeeUnion } from "./approval-doorway";
export { maySeeUnion };

export const INBOX_FILTER_KINDS: Record<string, InboxKind[]> = {
  approvals: ["flows_approval", "expense_report", "timesheet_approval"],
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
    // Period reopen requests awaiting an independent close.reopen approver.
    "close_reopen_request",
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

export type InboxTaskFilter = "all" | "my_tasks" | "signatures" | "notices" | "overdue";

/** The selected task view reads one live population for every presentation filter.
 * Other views retain native badge counts without materializing hidden task rows. */
export async function inboxTaskFilters(ctx: InboxListContext, selected = true) {
  const notices: InboxSourceNotice[] = [];
  const items = selected ? await listInbox(ctx, { kinds: INBOX_TASK_KINDS, notices }) : [];
  const filters: Record<InboxTaskFilter, InboxItem[]> = {
    all: items,
    my_tasks: items.filter((item) => INBOX_FILTER_KINDS.my_tasks!.includes(item.kind)),
    signatures: items.filter((item) => INBOX_FILTER_KINDS.signatures!.includes(item.kind)),
    notices: items.filter((item) => INBOX_FILTER_KINDS.notices!.includes(item.kind)),
    overdue: items.filter((item) => item.priority === "overdue"),
  };
  return { filters, notices };
}

/** Unfiltered personal work totals shared by navigation, Inbox and Home.
 * Count each source rather than a bounded list window. The badge totals the
 * My Approvals and My Tasks tabs, independent of the active tab or filters.
 * Direct timesheet approvals count with approvals: they await this actor's
 * decision exactly like a gate, through the same native command. */
export async function inboxCounts(authz: Authz, ctx: InboxListContext) {
  const notices: InboxSourceNotice[] = [];
  const [unionApprovals, directApprovals, tasks] = await Promise.all([
    maySeeUnion(authz)
      ? import("./application/approvals").then(({ approvalWorklistCountForAuthz }) => approvalWorklistCountForAuthz(authz))
      : Promise.resolve(0),
    countInbox(ctx, { kinds: ["timesheet_approval"], notices }),
    countInbox(ctx, { kinds: INBOX_TASK_KINDS, notices }),
  ]);
  const approvals = unionApprovals + directApprovals;
  return { approvals, tasks, count: approvals + tasks, notices };
}
