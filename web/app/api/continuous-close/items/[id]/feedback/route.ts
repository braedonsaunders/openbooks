import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { getAuthz } from "../../../../../../lib/authz";
import { isUuid } from "../../../../../../lib/list-params";
import { canReadContinuousCloseAgent, loadWorkItemAccess } from "../../../../../../lib/continuous-close";

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const access = await loadWorkItemAccess(authz.user.orgId, id);
  if (!access) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!canReadContinuousCloseAgent(authz, access.agentKey)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const rating = body.rating === "helpful" || body.rating === "not_helpful" ? body.rating : null;
  if (!rating) return NextResponse.json({ error: "invalid_rating" }, { status: 422 });
  const comment = typeof body.comment === "string" ? body.comment.trim().slice(0, 500) || null : null;
  await db.execute(sql`
    insert into ai_work_item_feedback (org_id, work_item_id, user_id, rating, comment)
    values (${authz.user.orgId}, ${id}, ${authz.user.id}, ${rating}, ${comment})
    on conflict (work_item_id, user_id) do update set
      rating = excluded.rating, comment = excluded.comment, updated_at = now()
  `);
  return NextResponse.json({ ok: true, rating });
}
