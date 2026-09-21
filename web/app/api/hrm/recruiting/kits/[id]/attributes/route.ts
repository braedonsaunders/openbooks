import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { addKitAttribute } from "@openbooks/engine/src/hrm/recruiting/kits.ts";
import { guardPermission } from "../../../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../../../lib/features";
import { recruitingErrorResponse } from "../../../_lib";
import { createAttributeBody } from "../../bodies";

export const runtime = "nodejs";

/**
 * Kit attributes: POST appends a rated attribute at an explicit position
 * (manage gate in the service). 404s while hrm, hrmRecruiting, or
 * hrmStructuredInterviews is off.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.recruiting.manage");
  if (gate instanceof NextResponse) return gate;
  if (
    !(await isFeatureEnabled(gate.user.orgId, "hrm")) ||
    !(await isFeatureEnabled(gate.user.orgId, "hrmRecruiting")) ||
    !(await isFeatureEnabled(gate.user.orgId, "hrmStructuredInterviews"))
  ) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await params;
  const parsedBody = await parseJsonBody(req, createAttributeBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const attribute = await addKitAttribute({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      kitId: id,
      category: body.category,
      attribute: body.attribute,
      description: body.description,
      position: body.position,
      isFocusDefault: body.isFocusDefault,
    });
    return NextResponse.json({ attribute }, { status: 201 });
  } catch (e) {
    return recruitingErrorResponse(e);
  }
}
