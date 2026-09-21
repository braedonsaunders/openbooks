import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { listOfferVersions, renderOfferVersion } from "@openbooks/engine/src/hrm/recruiting/offers-signing.ts";
import { guardPermission } from "../../../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../../../lib/features";
import { recruitingErrorResponse } from "../../../_lib";
import { renderOfferVersionBody } from "./bodies";

export const runtime = "nodejs";

/**
 * Offer versions: GET lists the regeneration history, POST renders a new
 * version (never an overwrite — manage gate in the service). 404s while
 * hrm, hrmRecruiting, or hrmOfferSigning is off.
 */
async function depthGate(orgId: string) {
  if (!(await isFeatureEnabled(orgId, "hrm"))) return false;
  if (!(await isFeatureEnabled(orgId, "hrmRecruiting"))) return false;
  return isFeatureEnabled(orgId, "hrmOfferSigning");
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.recruiting.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await depthGate(gate.user.orgId))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await params;
  try {
    const versions = await listOfferVersions({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      offerId: id,
    });
    return NextResponse.json({ versions });
  } catch (e) {
    return recruitingErrorResponse(e);
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.recruiting.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await depthGate(gate.user.orgId))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await params;
  const parsedBody = await parseJsonBody(req, renderOfferVersionBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const version = await renderOfferVersion({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      offerId: id,
      templateId: body.templateId,
      selectedClauseKeys: body.selectedClauseKeys,
      renderedFileId: body.renderedFileId,
    });
    return NextResponse.json({ version }, { status: 201 });
  } catch (e) {
    return recruitingErrorResponse(e);
  }
}
