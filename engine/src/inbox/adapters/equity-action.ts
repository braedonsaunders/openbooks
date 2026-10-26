/**
 * equity_action adapter — governed equity actions an Equity action Flow holds
 * for a decision, for the approvers its gates name.
 *
 * The approvals union (My approvals) already lists every pending gate for a
 * caller who reaches it (the Flows feature on and flows.approve held). An
 * approver whose role carries only the equity grants (equity.read and
 * equity.approve) never reaches that union, so their equity gates list here,
 * among their tasks, instead — one piece of work is one inbox item for every
 * approver. Decisions run through decideGate, the single authority that
 * refuses the requester and releases the action through the equity module,
 * which also requires equity.approve over the request's legal entity.
 *
 * The requester's own side of a pending action (where it stands, and its
 * withdrawal) is Submitted by me, not a task: waiting on someone else is not
 * work waiting on the requester.
 */

import { EQUITY_ACTION_SUBJECT_KIND } from "../../flows/equity-actions-adapter.ts";
import { decideGate, gateDecisionCapability, type WorklistGate } from "../../flows/gates.ts";
import { actorPendingGates, actorPermissionOn, orgFeatureOn, toWorklistScope } from "../guard.ts";
import { InboxError, type InboxAdapter } from "../registry.ts";
import type { InboxItem, InboxListContext } from "../types.ts";
import { inboxItemId, priorityForDueDate } from "../types.ts";

/** The equity feature switch (Company Settings → Features). */
const EQUITY_FEATURE = "equity";

/** True when the caller's pending gates already list in the approvals union. */
async function reachesApprovalsUnion(ctx: InboxListContext): Promise<boolean> {
  return (await orgFeatureOn(ctx, "flows")) && (await actorPermissionOn(ctx, "flows.approve"));
}

async function equityGates(ctx: InboxListContext): Promise<WorklistGate[]> {
  if (!(await orgFeatureOn(ctx, EQUITY_FEATURE))) return [];
  if (await reachesApprovalsUnion(ctx)) return [];
  return (await actorPendingGates(ctx)).filter(
    (gate) => gate.subjectKind === EQUITY_ACTION_SUBJECT_KIND,
  );
}

async function toItem(gate: WorklistGate, ctx: InboxListContext): Promise<InboxItem> {
  const dueAt = gate.escalateAt ? new Date(gate.escalateAt).toISOString() : null;
  const onBehalf = gate.onBehalfOf ? ` on behalf of ${gate.onBehalfOf.name}` : "";
  const subject = gate.subjectLabel ?? "Equity action";
  // The same separation-of-duties check the decision enforces, resolved in
  // advance: a gate this actor may not decide shows no decision actions.
  const awaitingAnother = (await gateDecisionCapability(gate.id, ctx.actorId)).sodBlocked;
  return {
    id: inboxItemId("equity_action", `gate:${gate.id}`),
    kind: "equity_action",
    title: gate.title,
    subtitle: awaitingAnother
      ? `Awaiting another approver — ${subject}${onBehalf}`
      : `${subject}${onBehalf}`,
    dueAt,
    createdAt: new Date(gate.createdAt).toISOString(),
    waitingSince: new Date(gate.createdAt).toISOString(),
    priority: priorityForDueDate(dueAt, ctx.asOf, ctx.timeZone),
    subjectHref: gate.href ?? `/equity?request=${gate.subjectId}`,
    actions: awaitingAnother
      ? []
      : [
          { key: "approve", label: "Approve", style: "primary", needsReason: false },
          { key: "reject", label: "Reject", style: "danger", needsReason: true },
        ],
    source: { kind: "flow_gate", id: gate.id },
  };
}

export const equityActionAdapter: InboxAdapter = {
  kind: "equity_action",
  async list(ctx) {
    const gates = await equityGates(ctx);
    const items: InboxItem[] = [];
    for (const gate of gates) items.push(await toItem(gate, ctx));
    return items;
  },
  async lookup(ctx, sourceId) {
    if (!sourceId.startsWith("gate:")) return null;
    const gateId = sourceId.slice("gate:".length);
    const gate = (await equityGates(ctx)).find((row) => row.id === gateId);
    return gate ? toItem(gate, ctx) : null;
  },
  async act(ctx, sourceId, actionKey, reason) {
    if (!sourceId.startsWith("gate:")) {
      throw new InboxError("NOT_FOUND", "this equity action is no longer awaiting your decision");
    }
    const gateId = sourceId.slice("gate:".length);
    // The session's subsidiary boundary rides into the decision, so deciding
    // by id refuses an out-of-scope gate rather than only hiding it.
    const allowedSubsidiaryIds = toWorklistScope(ctx).allowedSubsidiaryIds;
    if (actionKey === "approve") {
      await decideGate({
        gateId,
        decision: "approved",
        userId: ctx.actorId,
        comment: reason,
        allowedSubsidiaryIds,
      });
      return;
    }
    if (actionKey === "reject") {
      await decideGate({
        gateId,
        decision: "rejected",
        userId: ctx.actorId,
        comment: reason,
        allowedSubsidiaryIds,
      });
      return;
    }
    throw new InboxError(
      "UNKNOWN_ACTION",
      `action ${JSON.stringify(actionKey)} is not available on an equity action`,
    );
  },
};
