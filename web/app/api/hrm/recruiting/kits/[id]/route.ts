import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { deleteKit, setKitActive } from "@openbooks/engine/src/hrm/recruiting/kits.ts";
import { guardPermission } from "../../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../../lib/features";
import { recruitingErrorResponse } from "../../_lib";
import { setKitActiveBody } from "../bodies";

export const runtime = "nodejs";

/**
 * One interview kit: PATCH setActive retires/reactivates, DELETE removes a
 * kit with no sittings (a kit with interviews refuses by name). 404s while
 * hrm, hrmRecruiting, or hrmStructuredInterviews is off.
 */
async function depthGate(orgId: string) {
  if (!(await isFeatureEnabled(orgId, "hrm"))) return false;
  if (!(await isFeatureEnabled(orgId, "hrmRecruiting"))) return false;
  return isFeatureEnabled(orgId, "hrmStructuredInterviews");
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.recruiting.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await depthGate(gate.user.orgId))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await params;
  const parsedBody = await parseJsonBody(req, setKitActiveBody);
  if (!parsedBody.ok) return parsedBody.response;
  try {
    const kit = await setKitActive({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      kitId: id,
      isActive: parsedBody.data.isActive,
    });
    return NextResponse.json({ kit });
  } catch (e) {
    return recruitingErrorResponse(e);
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.recruiting.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await depthGate(gate.user.orgId))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await params;
  try {
    await deleteKit({ orgId: gate.user.orgId, actorId: gate.user.id, kitId: id });
    return NextResponse.json({ deleted: id });
  } catch (e) {
    return recruitingErrorResponse(e);
  }
}
