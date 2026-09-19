import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import {
  getChangeRequest,
  updateChangeRequestPayload,
} from "@openbooks/engine/src/hrm/change-requests.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { isUuid } from "../../../../../lib/list-params";
import { changeRequestErrorResponse, patchChangeRequestBody } from "../_lib";

export const runtime = "nodejs";

/** Single employment change request: GET reads, PATCH edits the draft payload. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.employment.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "request id must be a uuid" }, { status: 400 });
  try {
    const request = await getChangeRequest({ orgId: gate.user.orgId, actorId: gate.user.id, requestId: id });
    return NextResponse.json({ request });
  } catch (e) {
    return changeRequestErrorResponse(e);
  }
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.employment.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "request id must be a uuid" }, { status: 400 });
  const parsedBody = await parseJsonBody(req, patchChangeRequestBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const request = await updateChangeRequestPayload({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      requestId: id,
      payload: body.payload,
    });
    return NextResponse.json({ request });
  } catch (e) {
    return changeRequestErrorResponse(e);
  }
}
