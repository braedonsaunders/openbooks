import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { addKitQuestion } from "@openbooks/engine/src/hrm/recruiting/kits.ts";
import { guardPermission } from "../../../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../../../lib/features";
import { recruitingErrorResponse } from "../../../_lib";
import { createQuestionBody } from "../../bodies";

export const runtime = "nodejs";

/**
 * Kit questions: POST appends a suggested question at an explicit position,
 * optionally pinned to one of the kit's attributes (manage gate in the
 * service). 404s while hrm, hrmRecruiting, or hrmStructuredInterviews is off.
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
  const parsedBody = await parseJsonBody(req, createQuestionBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const question = await addKitQuestion({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      kitId: id,
      question: body.question,
      position: body.position,
      attributeId: body.attributeId,
    });
    return NextResponse.json({ question }, { status: 201 });
  } catch (e) {
    return recruitingErrorResponse(e);
  }
}
