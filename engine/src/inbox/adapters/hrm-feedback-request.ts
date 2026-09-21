/**
 * HR-17 hrm_feedback_request adapter — feedback requests waiting on the actor.
 *
 * Reads through listOpenRequestsForParty (the visibility-scoped feedback
 * service): open kind=request rows addressed to the actor's party.
 * Fulfilment writing stays in the feedback surface (link-only with the
 * remedy named) — the adapter never writes feedback itself.
 *
 * While the hrmFeedback feature is off the service refuses, so the
 * adapter lists nothing (fail-closed) — the inbox stays up for every org.
 */

import { listOpenRequestsForParty } from "../../hrm/performance/feedback.ts";
import { db } from "../../platform/db.ts";
import { hrmOn } from "../guard.ts";
import type { InboxAdapter } from "../registry.ts";
import type { InboxItem, InboxListContext } from "../types.ts";
import { inboxItemId } from "../types.ts";

export const hrmFeedbackRequestAdapter: InboxAdapter = {
  kind: "hrm_feedback_request",
  async list(ctx: InboxListContext): Promise<InboxItem[]> {
    if (!(await hrmOn(db, ctx.orgId))) return [];
    let requests;
    try {
      requests = await listOpenRequestsForParty({ orgId: ctx.orgId, actorId: ctx.actorId });
    } catch {
      // Feature off or no person identity: fail closed, list nothing.
      return [];
    }
    return requests.map(
      (request): InboxItem => ({
        id: inboxItemId("hrm_feedback_request", request.id),
        kind: "hrm_feedback_request",
        title: "Feedback requested",
        subtitle: "a colleague asked for your feedback — respond from the feedback surface",
        dueAt: null,
        createdAt: request.recordedAt,
        priority: "normal",
        subjectHref: `/me/one-on-ones?request=${request.id}`,
        actions: [],
        source: { kind: "hrm_feedback_request", id: request.id },
      }),
    );
  },
  async act(): Promise<void> {
    throw new Error(
      `answering a feedback request happens in the feedback surface itself — open the item and write the fulfilment there`,
    );
  },
};
