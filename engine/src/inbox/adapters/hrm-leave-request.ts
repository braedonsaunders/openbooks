/**
 * HR-15 hrm_leave_request adapter — leave, both sides of the desk.
 *
 * Approver leg: flow gates on hrm_leave_request subjects where the actor
 * can act (read through worklistApprovals, owned here so flows_approval
 * excludes them — one piece of work, one inbox item). Acts through
 * decideGate / delegateGate.
 *
 * Own leg: my draft and returned requests, read through myLeaveRequests
 * (the same loader the my-leave page renders from). Acts through
 * submitLeaveRequest — the submit route's service.
 */

import { HRM_LEAVE_REQUEST_SUBJECT_KIND } from "@openbooks/schema/src/hrm-leave.ts";
import { decideGate, delegateGate } from "../../flows/gates.ts";
import { worklistApprovals } from "../../flows/approval-worklist.ts";
import { loadOwnEmploymentIds } from "../../hrm/authorization.ts";
import { submitLeaveRequest } from "../../hrm/leave.ts";
import { mayReadOwnLeaveRequests, myLeaveRequests } from "../../hrm/leave-read.ts";
import { db } from "../../platform/db.ts";
import { isUuid } from "../../platform/uuid.ts";
import { hrmOn, toWorklistScope } from "../guard.ts";
import type { InboxAdapter } from "../registry.ts";
import type { InboxItem, InboxListContext } from "../types.ts";
import { inboxItemId, priorityForDueDate } from "../types.ts";

export const hrmLeaveRequestAdapter: InboxAdapter = {
  kind: "hrm_leave_request",
  async list(ctx: InboxListContext): Promise<InboxItem[]> {
    if (!(await hrmOn(db, ctx.orgId))) return [];
    const out: InboxItem[] = [];
    // Approver leg — gates on leave subjects addressed to me.
    const approvals = await worklistApprovals(ctx.orgId, ctx.actorId, toWorklistScope(ctx));
    for (const item of approvals) {
      if (item.kind !== "flow_gate" || item.gate.subjectKind !== HRM_LEAVE_REQUEST_SUBJECT_KIND) continue;
      const gate = item.gate;
      const dueAt = gate.escalateAt ? new Date(gate.escalateAt).toISOString() : null;
      out.push({
        id: inboxItemId("hrm_leave_request", `gate:${gate.id}`),
        kind: "hrm_leave_request",
        title: gate.title,
        subtitle: `leave approval${gate.onBehalfOf ? ` on behalf of ${gate.onBehalfOf.name}` : ""} — waiting since ${new Date(gate.createdAt).toISOString().slice(0, 10)}`,
        dueAt,
        createdAt: new Date(gate.createdAt).toISOString(),
        priority: priorityForDueDate(dueAt, ctx.asOf),
        subjectHref: gate.href ?? "/hrm/leave",
        actions: [
          // The leave release requires a non-blank reason even to approve
          // (staffing evidence) — the source names it, so the inbox collects it.
          { key: "approve", label: "Approve", style: "primary", needsReason: true },
          { key: "reject", label: "Reject", style: "danger", needsReason: true },
          { key: "delegate", label: "Delegate", style: "secondary", needsReason: true },
        ],
        source: { kind: "hrm_leave_request_gate", id: gate.id },
      });
    }
    // Own leg — my drafts ready to submit. Self-service only, probed BEFORE
    // the read: the actor needs the same permission myLeaveRequests enforces
    // (reused here, never redefined) AND a linked employment. Anyone else —
    // approvers, accountants — contributes zero own-leg items, never the
    // named refusal, which used to blank the whole inbox (OM-10). The
    // approver leg above keeps its own gates, unchanged.
    if (
      (await mayReadOwnLeaveRequests(db, ctx.orgId, ctx.actorId)) &&
      (await loadOwnEmploymentIds(db, ctx.orgId, ctx.actorId)).length > 0
    ) {
      const mine = await myLeaveRequests({ orgId: ctx.orgId, actorId: ctx.actorId });
      for (const request of mine) {
        if (request.status !== "draft") continue;
        out.push({
          id: inboxItemId("hrm_leave_request", `own:${request.id}`),
          kind: "hrm_leave_request",
          title: "Leave request draft",
          subtitle: `${request.leaveTypeCode} · ${request.startsOn} → ${request.endsOn}`,
          dueAt: null,
          createdAt: ctx.asOf,
          priority: "normal",
          subjectHref: `/hrm/my-leave?request=${request.id}`,
          actions: [{ key: "submit", label: "Submit", style: "primary", needsReason: false }],
          source: { kind: "hrm_leave_request", id: request.id },
        });
      }
    }
    return out;
  },
  async act(ctx, sourceId, actionKey, reason): Promise<void> {
    // The session's subsidiary boundary rides into the write authority (see
    // flows_approval): deciding by id refuses out-of-scope work by name.
    const allowedSubsidiaryIds = toWorklistScope(ctx).allowedSubsidiaryIds;
    if (sourceId.startsWith("gate:")) {
      const gateId = sourceId.slice("gate:".length);
      if (actionKey === "approve") {
        await decideGate({ gateId, decision: "approved", userId: ctx.actorId, comment: reason, allowedSubsidiaryIds });
        return;
      }
      if (actionKey === "reject") {
        await decideGate({ gateId, decision: "rejected", userId: ctx.actorId, comment: reason, allowedSubsidiaryIds });
        return;
      }
      if (actionKey === "delegate") {
        const match = /^user:(\S+)\s*:?\s*(.*)$/i.exec(reason ?? "");
        if (!match || !isUuid(match[1])) {
          throw new Error(
            "delegation needs a recipient — give the reason as the colleague taking over, then the handover note",
          );
        }
        await delegateGate(gateId, ctx.actorId, match[1]!, allowedSubsidiaryIds);
        return;
      }
    }
    if (sourceId.startsWith("own:")) {
      if (actionKey === "submit") {
        await submitLeaveRequest({ orgId: ctx.orgId, actorId: ctx.actorId, requestId: sourceId.slice("own:".length) });
        return;
      }
    }
    throw new Error(`action ${JSON.stringify(actionKey)} is not available on this leave request`);
  },
};
