/**
 * HR-15 expense_report adapter — expense reports awaiting my approval.
 *
 * Expense reports submit into Flows approval (draft → submit → approved
 * → post), so the approver leg is the flow gates on expense_report
 * subjects — owned here so flows_approval excludes them. Acts through
 * decideGate / delegateGate, the same decision path the expenses surface
 * uses; posting stays in expenses after approval.
 */

import { decideGate, delegateGate } from "../../flows/gates.ts";
import { worklistApprovals } from "../../flows/approval-worklist.ts";
import { toWorklistScope } from "../guard.ts";
import { isUuid } from "../../platform/uuid.ts";
import type { InboxAdapter } from "../registry.ts";
import type { InboxItem, InboxListContext } from "../types.ts";
import { inboxItemId, priorityForDueDate } from "../types.ts";

export const expenseReportAdapter: InboxAdapter = {
  kind: "expense_report",
  async list(ctx: InboxListContext): Promise<InboxItem[]> {
    const out: InboxItem[] = [];
    const approvals = await worklistApprovals(ctx.orgId, ctx.actorId, toWorklistScope(ctx));
    for (const item of approvals) {
      if (item.kind === "flow_gate") {
        if (item.gate.subjectKind !== "expense_report") continue;
        const gate = item.gate;
        const dueAt = gate.escalateAt ? new Date(gate.escalateAt).toISOString() : null;
        out.push({
          id: inboxItemId("expense_report", `gate:${gate.id}`),
          kind: "expense_report",
          title: gate.title,
          subtitle: `expense approval${gate.onBehalfOf ? ` on behalf of ${gate.onBehalfOf.name}` : ""} — waiting since ${new Date(gate.createdAt).toISOString().slice(0, 10)}`,
          dueAt,
          createdAt: new Date(gate.createdAt).toISOString(),
          priority: priorityForDueDate(dueAt, ctx.asOf),
          subjectHref: gate.href ?? "/expenses/reports",
          actions: [
            { key: "approve", label: "Approve", style: "primary", needsReason: false },
            { key: "reject", label: "Reject", style: "danger", needsReason: true },
            { key: "delegate", label: "Delegate", style: "secondary", needsReason: true },
          ],
          source: { kind: "expense_report_gate", id: gate.id },
        });
      } else if (item.kind === "document") {
        if (item.document.docKind !== "expense_report") continue;
        const doc = item.document;
        const createdAt = new Date(doc.submittedAt ?? doc.createdAt).toISOString();
        out.push({
          id: inboxItemId("expense_report", `document:${doc.id}`),
          kind: "expense_report",
          title: doc.documentNumber ? `Expense report ${doc.documentNumber}` : "Expense report",
          subtitle: doc.partyName ?? null,
          dueAt: null,
          createdAt,
          priority: "normal",
          subjectHref: "/expenses/reports",
          actions: [
            { key: "approve", label: "Approve", style: "primary", needsReason: false },
            { key: "reject", label: "Reject", style: "danger", needsReason: true },
          ],
          source: { kind: "expense_report", id: doc.id },
        });
      }
    }
    return out;
  },
  async act(ctx, sourceId, actionKey, reason): Promise<void> {
    const { decideDocumentApproval } = await import("../../flows/approval-worklist.ts");
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
    if (sourceId.startsWith("document:")) {
      const id = sourceId.slice("document:".length);
      if (actionKey === "approve") {
        await decideDocumentApproval(ctx.orgId, id, ctx.actorId, "approved", reason, allowedSubsidiaryIds);
        return;
      }
      if (actionKey === "reject") {
        await decideDocumentApproval(ctx.orgId, id, ctx.actorId, "rejected", reason, allowedSubsidiaryIds);
        return;
      }
    }
    throw new Error(`action ${JSON.stringify(actionKey)} is not available on this expense report`);
  },
};
