/**
 * HR-15 hrm_change_request adapter — change requests, both sides.
 *
 * Approver leg: flow gates on hrm_employment_change_request subjects
 * (owned here so flows_approval excludes them). Acts through decideGate /
 * delegateGate — the gate release path the change-request page uses.
 *
 * Own leg: my drafts (created_by = me, status draft) through
 * listChangeRequests, which already applies the kind-aware read gate.
 * Acts through submitChangeRequest — the submit route's service, which
 * needs a reason, so the submit action collects one.
 */

import { HRM_CHANGE_REQUEST_SUBJECT_KIND } from "@openbooks/schema/src/hrm-change-requests.ts";
import { decideGate, delegateGate } from "../../flows/gates.ts";
import { worklistApprovals } from "../../flows/approval-worklist.ts";
import { listChangeRequests, submitChangeRequest } from "../../hrm/change-requests.ts";
import { db } from "../../platform/db.ts";
import { hrmOn, toWorklistScope } from "../guard.ts";
import type { InboxAdapter } from "../registry.ts";
import type { InboxItem, InboxListContext } from "../types.ts";
import { inboxItemId, priorityForDueDate } from "../types.ts";

export const hrmChangeRequestAdapter: InboxAdapter = {
  kind: "hrm_change_request",
  async list(ctx: InboxListContext): Promise<InboxItem[]> {
    if (!(await hrmOn(db, ctx.orgId))) return [];
    const out: InboxItem[] = [];
    const approvals = await worklistApprovals(ctx.orgId, ctx.actorId, toWorklistScope(ctx));
    for (const item of approvals) {
      if (item.kind !== "flow_gate" || item.gate.subjectKind !== HRM_CHANGE_REQUEST_SUBJECT_KIND) continue;
      const gate = item.gate;
      const dueAt = gate.escalateAt ? new Date(gate.escalateAt).toISOString() : null;
      out.push({
        id: inboxItemId("hrm_change_request", `gate:${gate.id}`),
        kind: "hrm_change_request",
        title: gate.title,
        subtitle: `change request approval${gate.onBehalfOf ? ` on behalf of ${gate.onBehalfOf.name}` : ""} — waiting since ${new Date(gate.createdAt).toISOString().slice(0, 10)}`,
        dueAt,
        createdAt: new Date(gate.createdAt).toISOString(),
        priority: priorityForDueDate(dueAt, ctx.asOf),
        subjectHref: gate.href ?? "/hrm/change-requests",
        actions: [
          { key: "approve", label: "Approve", style: "primary", needsReason: false },
          { key: "reject", label: "Reject", style: "danger", needsReason: true },
          { key: "delegate", label: "Delegate", style: "secondary", needsReason: true },
        ],
        source: { kind: "hrm_employment_change_request_gate", id: gate.id },
      });
    }
    const drafts = await listChangeRequests({ orgId: ctx.orgId, actorId: ctx.actorId, status: "draft" });
    for (const draft of drafts) {
      if (draft.createdBy !== ctx.actorId) continue;
      out.push({
        id: inboxItemId("hrm_change_request", `own:${draft.id}`),
        kind: "hrm_change_request",
        title: `Change request draft — ${draft.payload.kind.replace(/_/g, " ")}`,
        subtitle: "saved but not submitted — submitting routes it for approval",
        dueAt: null,
        createdAt: ctx.asOf,
        priority: "normal",
        subjectHref: `/hrm/change-requests?request=${draft.id}`,
        actions: [{ key: "submit", label: "Submit", style: "primary", needsReason: true }],
        source: { kind: "hrm_employment_change_request", id: draft.id },
      });
    }
    return out;
  },
  async act(ctx, sourceId, actionKey, reason): Promise<void> {
    if (sourceId.startsWith("gate:")) {
      const gateId = sourceId.slice("gate:".length);
      if (actionKey === "approve") {
        await decideGate({ gateId, decision: "approved", userId: ctx.actorId, comment: reason });
        return;
      }
      if (actionKey === "reject") {
        await decideGate({ gateId, decision: "rejected", userId: ctx.actorId, comment: reason });
        return;
      }
      if (actionKey === "delegate") {
        const match = /^user:([0-9a-f-]{36})\s*:?\s*(.*)$/i.exec(reason ?? "");
        if (!match) {
          throw new Error(
            "delegation needs a recipient — give the reason as the colleague taking over, then the handover note",
          );
        }
        await delegateGate(gateId, ctx.actorId, match[1]!);
        return;
      }
    }
    if (sourceId.startsWith("own:")) {
      if (actionKey === "submit") {
        await submitChangeRequest({
          orgId: ctx.orgId,
          actorId: ctx.actorId,
          requestId: sourceId.slice("own:".length),
          reason: reason ?? "",
        });
        return;
      }
    }
    throw new Error(`action ${JSON.stringify(actionKey)} is not available on this change request`);
  },
};
