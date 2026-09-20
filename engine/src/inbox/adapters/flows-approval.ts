/**
 * HR-15 flows_approval adapter — the approvals leg of the inbox.
 *
 * Wraps worklistApprovalsPage (the same paged union reader the inbox page
 * and the dashboard tile render from — documents, pay runs, budgets, flow
 * gates — so the three can never disagree) and acts through decideGate /
 * delegateGate / decideDocumentApproval — the existing write path, never
 * a second one.
 *
 * Mapped legs: flow gates and gateless documents carry inbox actions.
 * Budget and pay-run legs are decision items with specialized decide paths
 * (checker flow, idempotent run approval) — they stay on the inbox page's
 * union table and are not inbox actions.
 *
 * Dedupe: gates whose subject is owned by a dedicated inbox adapter are
 * excluded here and listed there instead (leave, change request,
 * timesheet week, expense report). One piece of work is one inbox item.
 */

import { HRM_CHANGE_REQUEST_SUBJECT_KIND } from "@openbooks/schema/src/hrm-change-requests.ts";
import { HRM_LEAVE_REQUEST_SUBJECT_KIND } from "@openbooks/schema/src/hrm-leave.ts";
import { TIMESHEET_WEEK_SUBJECT_KIND } from "../../flows/timesheet-weeks-adapter.ts";
import {
  decideDocumentApproval,
  worklistApprovalsPage,
  type UnifiedApproval,
} from "../../flows/approval-worklist.ts";
import { decideGate, delegateGate } from "../../flows/gates.ts";
import type { InboxAdapter } from "../registry.ts";
import type { InboxItem, InboxListContext } from "../types.ts";
import { inboxItemId, priorityForDueDate } from "../types.ts";

/** Gate subjects owned by dedicated inbox adapters (listed there, not here). */
export const INBOX_OWNED_GATE_SUBJECTS: ReadonlySet<string> = new Set([
  HRM_LEAVE_REQUEST_SUBJECT_KIND,
  HRM_CHANGE_REQUEST_SUBJECT_KIND,
  TIMESHEET_WEEK_SUBJECT_KIND,
  "expense_report",
]);

/** Bounded head window: the inbox is a working list, not an archive scan. */
export const INBOX_UNION_WINDOW = { offset: 0, limit: 100 } as const;

function gateItem(gate: Extract<UnifiedApproval, { kind: "flow_gate" }>["gate"], ctx: InboxListContext): InboxItem | null {
  if (INBOX_OWNED_GATE_SUBJECTS.has(gate.subjectKind)) return null;
  const dueAt = gate.escalateAt ? new Date(gate.escalateAt).toISOString() : null;
  const onBehalf = gate.onBehalfOf ? ` on behalf of ${gate.onBehalfOf.name}` : "";
  return {
    id: inboxItemId("flows_approval", `gate:${gate.id}`),
    kind: "flows_approval",
    title: gate.title,
    subtitle: `${gate.subjectLabel ?? gate.subjectKind}${onBehalf} — waiting since ${new Date(gate.createdAt).toISOString().slice(0, 10)}`,
    dueAt,
    createdAt: new Date(gate.createdAt).toISOString(),
    priority: priorityForDueDate(dueAt, ctx.asOf),
    subjectHref: gate.href ?? "/inbox",
    actions: [
      { key: "approve", label: "Approve", style: "primary", needsReason: false },
      { key: "reject", label: "Reject", style: "danger", needsReason: true },
      { key: "delegate", label: "Delegate", style: "secondary", needsReason: true },
    ],
    source: { kind: "flow_gate", id: gate.id },
  };
}

function documentItem(
  doc: Extract<UnifiedApproval, { kind: "document" }>["document"],
  ctx: InboxListContext,
): InboxItem | null {
  if (doc.docKind === "expense_report") return null;
  const createdAt = new Date(doc.submittedAt ?? doc.createdAt).toISOString();
  return {
    id: inboxItemId("flows_approval", `document:${doc.id}`),
    kind: "flows_approval",
    title: doc.documentNumber ? `${doc.docKind} ${doc.documentNumber}` : doc.docKind,
    subtitle: doc.partyName ?? null,
    dueAt: null,
    createdAt,
    priority: "normal",
    subjectHref: `/inbox`,
    actions: [
      { key: "approve", label: "Approve", style: "primary", needsReason: false },
      { key: "reject", label: "Reject", style: "danger", needsReason: true },
    ],
    source: { kind: "document", id: doc.id },
  };
}

export const flowsApprovalAdapter: InboxAdapter = {
  kind: "flows_approval",
  async list(ctx: InboxListContext): Promise<InboxItem[]> {
    const scope = ctx.scope;
    const page = await worklistApprovalsPage(
      ctx.orgId,
      ctx.actorId,
      {
        ...(scope?.roles ? { roles: scope.roles } : {}),
        ...(scope?.allowedSubsidiaryIds !== undefined
          ? { allowedSubsidiaryIds: scope.allowedSubsidiaryIds === null ? null : new Set(scope.allowedSubsidiaryIds) }
          : {}),
        ...(scope?.includeBudgets !== undefined ? { includeBudgets: scope.includeBudgets } : {}),
        ...(scope?.includePayRuns !== undefined ? { includePayRuns: scope.includePayRuns } : {}),
        ...(scope?.payDirections ? { payDirections: [...scope.payDirections] } : {}),
      },
      { ...INBOX_UNION_WINDOW },
    );
    const out: InboxItem[] = [];
    for (const item of page.items) {
      if (item.kind === "flow_gate") {
        const mapped = gateItem(item.gate, ctx);
        if (mapped) out.push(mapped);
      } else if (item.kind === "document") {
        const mapped = documentItem(item.document, ctx);
        if (mapped) out.push(mapped);
      }
      // Budget and pay-run legs intentionally unmapped (see header).
    }
    return out;
  },
  async act(ctx, sourceId, actionKey, reason): Promise<void> {
    const sep = sourceId.indexOf(":");
    const leg = sourceId.slice(0, sep);
    const id = sourceId.slice(sep + 1);
    if (leg === "gate") {
      if (actionKey === "approve") {
        await decideGate({ gateId: id, decision: "approved", userId: ctx.actorId, comment: reason });
        return;
      }
      if (actionKey === "reject") {
        await decideGate({ gateId: id, decision: "rejected", userId: ctx.actorId, comment: reason });
        return;
      }
      if (actionKey === "delegate") {
        // The reason carries the delegatee user id: "user:<uuid>: <note>".
        // delegateGate resolves the target; the note stays in the comment.
        const match = /^user:([0-9a-f-]{36})\s*:?\s*(.*)$/i.exec(reason ?? "");
        if (!match) {
          throw new Error(
            "delegation needs a recipient — give the reason as the colleague taking over, then the handover note",
          );
        }
        await delegateGate(id, ctx.actorId, match[1]!);
        return;
      }
    }
    if (leg === "document") {
      if (actionKey === "approve") {
        await decideDocumentApproval(ctx.orgId, id, ctx.actorId, "approved", reason);
        return;
      }
      if (actionKey === "reject") {
        await decideDocumentApproval(ctx.orgId, id, ctx.actorId, "rejected", reason);
        return;
      }
    }
    throw new Error(`action ${JSON.stringify(actionKey)} is not available on this approval`);
  },
};
