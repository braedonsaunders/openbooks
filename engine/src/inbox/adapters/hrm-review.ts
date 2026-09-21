/**
 * HR-15 hrm_review adapter — performance reviews waiting on the actor.
 *
 * Reads through listMyReviews (the privacy-scoped performance read
 * service): reviews I must write as reviewer, self-assessments due as
 * subject, and shared reviews awaiting my acknowledgement. Acts through
 * acknowledgeReview for the acknowledge leg; assessment writing stays in
 * the performance surface (link-only with the remedy named).
 *
 * While the hrm feature is off the adapter lists nothing (explicit probe
 * in guard.ts) — the inbox stays up for every org.
 */

import { acknowledgeReview } from "../../hrm/performance/reviews.ts";
import { listMyReviews } from "../../hrm/performance/performance-read.ts";
import { db } from "../../platform/db.ts";
import { hrmOn } from "../guard.ts";
import type { InboxAdapter } from "../registry.ts";
import type { InboxItem, InboxListContext } from "../types.ts";
import { inboxItemId } from "../types.ts";

export const hrmReviewAdapter: InboxAdapter = {
  kind: "hrm_review",
  async list(ctx: InboxListContext): Promise<InboxItem[]> {
    if (!(await hrmOn(db, ctx.orgId))) return [];
    const mine = await listMyReviews({ orgId: ctx.orgId, actorId: ctx.actorId });
    const out: InboxItem[] = [];
    for (const review of mine.asReviewer) {
      if (review.status !== "pending") continue;
      out.push({
        id: inboxItemId("hrm_review", `write:${review.id}`),
        kind: "hrm_review",
        title: "Review to write",
        subtitle: "a report's review waits for your assessment — write it in the performance review",
        dueAt: null,
        createdAt: ctx.asOf,
        priority: "normal",
        subjectHref: `/hrm/performance?review=${review.id}`,
        actions: [],
        source: { kind: "hrm_review", id: review.id },
      });
    }
    for (const review of mine.asSubject) {
      if (review.status === "shared") {
        out.push({
          id: inboxItemId("hrm_review", `ack:${review.id}`),
          kind: "hrm_review",
          title: "Review shared — acknowledge",
          subtitle: "your review is shared — acknowledging closes the loop",
          dueAt: null,
          createdAt: ctx.asOf,
          priority: "due_soon",
          subjectHref: `/hrm/performance?review=${review.id}`,
          actions: [{ key: "acknowledge", label: "Acknowledge", style: "primary", needsReason: false }],
          source: { kind: "hrm_review", id: review.id },
        });
      } else if (review.status === "pending") {
        out.push({
          id: inboxItemId("hrm_review", `self:${review.id}`),
          kind: "hrm_review",
          title: "Self-assessment due",
          subtitle: "your input is due — write it in the performance review",
          dueAt: null,
          createdAt: ctx.asOf,
          priority: "normal",
          subjectHref: `/hrm/performance?review=${review.id}`,
          actions: [],
          source: { kind: "hrm_review", id: review.id },
        });
      }
    }
    return out;
  },
  async act(ctx, sourceId, actionKey): Promise<void> {
    if (sourceId.startsWith("ack:") && actionKey === "acknowledge") {
      await acknowledgeReview({ orgId: ctx.orgId, actorId: ctx.actorId, reviewId: sourceId.slice("ack:".length) });
      return;
    }
    throw new Error(
      `action ${JSON.stringify(actionKey)} is not available here — review writing happens in the performance review itself`,
    );
  },
};
