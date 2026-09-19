import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { submitChangeRequest } from "@openbooks/engine/src/hrm/change-requests.ts";
import { guardPermission } from "../../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../../lib/features";
import { isUuid } from "../../../../../../lib/list-params";
import { changeRequestErrorResponse } from "../../_lib";
import { submitChangeRequestBody } from "../../bodies";

export const runtime = "nodejs";

/** Submit a draft employment change request for governed approval. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.employment.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "request id must be a uuid" }, { status: 400 });
  const parsedBody = await parseJsonBody(req, submitChangeRequestBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const request = await submitChangeRequest({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      requestId: id,
      reason: body.reason,
    });
    return NextResponse.json({ request });
  } catch (e) {
    return changeRequestErrorResponse(e);
  }
}
