import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { getAuthz, subsidiaryScopeAllows } from "../../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../../lib/features";
import { isUuid } from "../../../../../../lib/list-params";
import {
  canReadContinuousCloseAgent,
  withLockedWorkItemAccess,
} from "../../../../../../lib/continuous-close";

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await isFeatureEnabled(authz.user.orgId, 'continuousClose'))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  let body: Record<string, unknown>;
  try {
    const parsedBody = await parseJsonBody(request, jsonObject);
    if (!parsedBody.ok) return parsedBody.response;
    body = parsedBody.data;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
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
  if (!result) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if ("error" in result) {
    return NextResponse.json(
      { error: result.error },
      { status: result.error === "forbidden" ? 403 : 404 },
    );
  }
  return NextResponse.json({ ok: true, rating: result.rating });
}
