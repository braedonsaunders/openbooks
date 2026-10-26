/** Native Flow approvals share one worklist and one gate decision path.
 * Dedicated subject adapters own their gates so one decision appears once. */

import { HRM_CHANGE_REQUEST_SUBJECT_KIND } from "@openbooks/schema/src/hrm-change-requests.ts";
import { HRM_LEAVE_REQUEST_SUBJECT_KIND } from "@openbooks/schema/src/hrm-leave.ts";
import { TIMESHEET_WEEK_SUBJECT_KIND } from "../../flows/timesheet-weeks-adapter.ts";
import { CREW_TIME_BATCH_SUBJECT_KIND } from "../../flows/crew-batches-adapter.ts";
import {
  worklistApprovalById,
  worklistApprovalsPage,
  type UnifiedApproval,
} from "../../flows/approval-worklist.ts";
import {
  decideGate,
  delegateGate,
  gateDecisionCapability,
  worklistGateKindCounts,
} from "../../flows/gates.ts";
import { isUuid } from "../../platform/uuid.ts";
import { toWorklistScope } from "../guard.ts";
import { parseDelegationReason } from "../delegation.ts";
import type { InboxAdapter, InboxPage } from "../registry.ts";
import type { InboxItem, InboxListContext } from "../types.ts";
import { inboxItemId, priorityForDueDate } from "../types.ts";

/** Gate subjects owned by dedicated inbox adapters (listed there, not here). */
export const INBOX_OWNED_GATE_SUBJECTS: ReadonlySet<string> = new Set([
  HRM_LEAVE_REQUEST_SUBJECT_KIND,
  HRM_CHANGE_REQUEST_SUBJECT_KIND,
  TIMESHEET_WEEK_SUBJECT_KIND,
  "expense_report",
  // HR-20 begin: crew gates are owned by the crew adapter below.
  CREW_TIME_BATCH_SUBJECT_KIND,
  // HR-20 end
]);

/** Bounded head window: the inbox is a working list, not an archive scan. */
export const INBOX_UNION_WINDOW = { offset: 0, limit: 100 } as const;

async function gateItem(
  gate: Extract<UnifiedApproval, { kind: "flow_gate" }>["gate"],
  ctx: InboxListContext,
): Promise<InboxItem | null> {
  if (!ctx.approvalWorklistOwnsGates && INBOX_OWNED_GATE_SUBJECTS.has(gate.subjectKind))
    return null;
  const dueAt = gate.escalateAt ? new Date(gate.escalateAt).toISOString() : null;
  const onBehalf = gate.onBehalfOf ? ` on behalf of ${gate.onBehalfOf.name}` : "";
  // Resolve the separation-of-duties outcome in advance through the same
  // native gate check the decide path enforces: a submitter/maker the
  // gate's prevent-self-approval excludes sees "Awaiting another approver"
  // with NO decision actions, never an Approve that refuses on click.
  const awaitingAnother = (await gateDecisionCapability(gate.id, ctx.actorId)).sodBlocked;
  return {
    id: inboxItemId("flows_approval", `gate:${gate.id}`),
    kind: "flows_approval",
    title: gate.title,
    subtitle: awaitingAnother
      ? `Awaiting another approver — ${gate.subjectLabel ?? gate.subjectKind}${onBehalf}`
      : `${gate.subjectLabel ?? gate.subjectKind}${onBehalf}`,
    dueAt,
    createdAt: new Date(gate.createdAt).toISOString(),
    waitingSince: new Date(gate.createdAt).toISOString(),
    priority: priorityForDueDate(dueAt, ctx.asOf, ctx.timeZone),
    subjectHref: gate.href ?? "/inbox",
    actions: awaitingAnother
      ? []
      : [
          {
            key: "approve",
            label: "Approve",
            style: "primary",
            needsReason: false,
          },
          {
            key: "reject",
            label: "Reject",
            style: "danger",
            needsReason: true,
          },
          {
            key: "delegate",
            label: "Delegate",
            style: "secondary",
            needsReason: true,
          },
        ],
    source: { kind: "flow_gate", id: gate.id },
  };
}

export const flowsApprovalAdapter: InboxAdapter = {
  kind: "flows_approval",
  async list(ctx: InboxListContext, page?: InboxPage): Promise<InboxItem[]> {
    const scope = ctx.scope;
    // Honor the caller's window so every counted item is reachable by
    // paging; absent means the bounded default, never the whole table.
    const window = page
      ? {
          offset: page.offset ?? 0,
          limit: page.limit ?? INBOX_UNION_WINDOW.limit,
        }
      : { ...INBOX_UNION_WINDOW };
    const approvals = await worklistApprovalsPage(
      ctx.orgId,
      ctx.actorId,
      {
        ...(scope?.roles ? { roles: scope.roles } : {}),
        ...(scope?.allowedSubsidiaryIds !== undefined
          ? {
              allowedSubsidiaryIds:
                scope.allowedSubsidiaryIds === null ? null : new Set(scope.allowedSubsidiaryIds),
            }
          : {}),
      },
      window,
    );
    const out: InboxItem[] = [];
    for (const item of approvals.items) {
      if (item.kind === "flow_gate") {
        const mapped = await gateItem(item.gate, ctx);
        if (mapped) out.push(mapped);
      }
    }
    return out;
  },
  async lookup(ctx: InboxListContext, sourceId: string): Promise<InboxItem | null> {
    const separator = sourceId.indexOf(":");
    if (separator < 1) return null;
    const leg = sourceId.slice(0, separator);
    const id = sourceId.slice(separator + 1);
    if (!isUuid(id) || leg !== "gate") return null;
    const item = await worklistApprovalById(ctx.orgId, ctx.actorId, toWorklistScope(ctx), id);
    if (!item) return null;
    if (item.kind === "flow_gate") return gateItem(item.gate, ctx);
    return null;
  },
  async count(ctx: InboxListContext): Promise<number> {
    const scope = toWorklistScope(ctx);
    const gateCounts = await worklistGateKindCounts(
      ctx.orgId,
      ctx.actorId,
      scope.roles,
      scope.allowedSubsidiaryIds,
    );
    let count = 0;
    for (const [kind, amount] of gateCounts) {
      if (ctx.approvalWorklistOwnsGates || !INBOX_OWNED_GATE_SUBJECTS.has(kind)) count += amount;
    }
    return count;
  },
  async act(ctx, sourceId, actionKey, reason): Promise<void> {
    // The session's subsidiary boundary rides into the write authority:
    // deciding by id must refuse an out-of-scope gate, not just hide it
    // from the list.
    const allowedSubsidiaryIds = toWorklistScope(ctx).allowedSubsidiaryIds;
    const sep = sourceId.indexOf(":");
    const leg = sourceId.slice(0, sep);
    const id = sourceId.slice(sep + 1);
    if (leg === "gate") {
      if (actionKey === "approve") {
        await decideGate({
          gateId: id,
          decision: "approved",
          userId: ctx.actorId,
          comment: reason,
          allowedSubsidiaryIds,
        });
        return;
      }
      if (actionKey === "reject") {
        await decideGate({
          gateId: id,
          decision: "rejected",
          userId: ctx.actorId,
          comment: reason,
          allowedSubsidiaryIds,
        });
        return;
      }
      if (actionKey === "delegate") {
        // The reason carries the delegatee user id plus the handover note:
        // "user:<uuid>: <note>". delegateGate resolves the target and
        // persists the note on the delegate's notice and the audit row.
        const delegation = parseDelegationReason(reason);
        await delegateGate(
          id,
          ctx.actorId,
          delegation.toUserId,
          allowedSubsidiaryIds,
          delegation.note,
        );
        return;
      }
    }
    throw new Error(`action ${JSON.stringify(actionKey)} is not available on this approval`);
  },
};
