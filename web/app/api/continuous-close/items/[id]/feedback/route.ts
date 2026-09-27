import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { subsidiaryScopeAllows } from "../../../../../../lib/authz";
import { isUuid } from "../../../../../../lib/list-params";
import {
  canReadContinuousCloseAgent,
  withLockedWorkItemAccess,
} from "../../../../../../lib/continuous-close";
import { notFound } from "@/lib/api/responses";

const feedbackBody = z.object({ rating: z.enum(["helpful", "not_helpful"]), comment: z.string().optional() });

export const PUT = defineRoute({
  permission: "assistant.use",
  feature: "continuousClose",
  params: z.object({ id: z.string() }),
  body: feedbackBody,
  handler: async ({ authz, params: { id }, body }) => {
  if (!isUuid(id)) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const rating = body.rating === "helpful" || body.rating === "not_helpful" ? body.rating : null;
  if (!rating) return NextResponse.json({ error: "invalid_rating" }, { status: 422 });
  const comment = typeof body.comment === "string" ? body.comment.trim().slice(0, 500) || null : null;
  // Resolve agent and scope inside the same row-locked
  // transaction as the insert. Feedback confirms the finding exists, so an
  // out-of-scope subject must answer like a missing item — a pre-check
  // followed by a later insert lets a rehome turn the rating into an
  // existence oracle for another entity's finding.
  const result = await withLockedWorkItemAccess(authz.user.orgId, id, async (tx, access) => {
    if (!canReadContinuousCloseAgent(authz, access.agentKey)) return { error: "forbidden" as const };
    if (!subsidiaryScopeAllows(authz.allowedSubsidiaryIds, access.subjectSubsidiaryId)) {
      return { error: "not_found" as const };
    }
    await tx.execute(sql`
      insert into ai_work_item_feedback (org_id, work_item_id, user_id, rating, comment)
      values (${authz.user.orgId}, ${id}, ${authz.user.id}, ${rating}, ${comment})
      on conflict (work_item_id, user_id) do update set
        rating = excluded.rating, comment = excluded.comment, updated_at = now()
      where ai_work_item_feedback.org_id = ${authz.user.orgId}
    `);
    return { rating };
  });
  if (!result) return notFound("record");
  if ("error" in result) {
    return NextResponse.json(
      { error: result.error },
      { status: result.error === "forbidden" ? 403 : 404 },
    );
  }
  return NextResponse.json({ ok: true, rating: result.rating });
  },
});
