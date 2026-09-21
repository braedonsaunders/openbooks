import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import {
  cancelOneOnOne,
  getOneOnOne,
  holdOneOnOne,
  skipOneOnOne,
} from "@openbooks/engine/src/hrm/performance/one-on-ones.ts";
import { getAuthz } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { performanceErrorResponse } from "../../review-cycles/_lib";
import { patchOneOnOneBody } from "../bodies";

export const runtime = "nodejs";

async function gated(orgId: string): Promise<boolean> {
  return (
    (await isFeatureEnabled(orgId, "hrm")) &&
    (await isFeatureEnabled(orgId, "hrmPerformance")) &&
    (await isFeatureEnabled(orgId, "hrmOneOnOnes"))
  );
}

/**
 * One 1:1. GET reads it (private items filtered to their author);
 * PATCH holds (carries open items forward), skips with a reason, or
 * cancels. The client checks res.ok before parsing.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await gated(authz.user.orgId))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await ctx.params;
  try {
    const one = await getOneOnOne({ orgId: authz.user.orgId, actorId: authz.user.id, id });
    return NextResponse.json({ oneOnOne: one });
  } catch (e) {
    return performanceErrorResponse(e);
  }
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await gated(authz.user.orgId))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, patchOneOnOneBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  const { id } = await ctx.params;
  try {
    if (body.action === "hold") {
      const one = await holdOneOnOne({ orgId: authz.user.orgId, actorId: authz.user.id, id });
      return NextResponse.json({ oneOnOne: one });
    }
    if (body.action === "skip") {
      const one = await skipOneOnOne({ orgId: authz.user.orgId, actorId: authz.user.id, id, reason: body.reason });
      return NextResponse.json({ oneOnOne: one });
    }
    await cancelOneOnOne({ orgId: authz.user.orgId, actorId: authz.user.id, id });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return performanceErrorResponse(e);
  }
}
