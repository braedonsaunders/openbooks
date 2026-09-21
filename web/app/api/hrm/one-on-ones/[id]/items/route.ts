import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import {
  addOneOnOneItem,
  getOneOnOne,
  setOneOnOneItemDone,
} from "@openbooks/engine/src/hrm/performance/one-on-ones.ts";
import { getAuthz } from "../../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../../lib/features";
import { performanceErrorResponse } from "../../../review-cycles/_lib";
import { addOneOnOneItemBody, patchOneOnOneItemBody } from "../../bodies";

export const runtime = "nodejs";

async function gated(orgId: string): Promise<boolean> {
  return (
    (await isFeatureEnabled(orgId, "hrm")) &&
    (await isFeatureEnabled(orgId, "hrmPerformance")) &&
    (await isFeatureEnabled(orgId, "hrmOneOnOnes"))
  );
}

/**
 * 1:1 agenda items. GET reads the 1:1 with its visibility-filtered
 * items; POST adds one; PATCH toggles done. The client checks res.ok
 * before parsing.
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
    return NextResponse.json({ items: one.items });
  } catch (e) {
    return performanceErrorResponse(e);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await gated(authz.user.orgId))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, addOneOnOneItemBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  const { id } = await ctx.params;
  try {
    const item = await addOneOnOneItem({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      oneOnOneId: id,
      kind: body.kind,
      body: body.body,
      visibility: body.visibility ?? "shared",
      assigneePartyId: body.assigneePartyId ?? null,
      dueOn: body.dueOn ?? null,
    });
    return NextResponse.json({ item }, { status: 201 });
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
  const parsedBody = await parseJsonBody(req, patchOneOnOneItemBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  const { id } = await ctx.params;
  try {
    await setOneOnOneItemDone({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      oneOnOneId: id,
      itemId: body.itemId,
      done: body.done,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return performanceErrorResponse(e);
  }
}
