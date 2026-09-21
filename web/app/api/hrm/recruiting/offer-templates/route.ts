import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { createOfferTemplate, listOfferTemplates } from "@openbooks/engine/src/hrm/recruiting/offers-signing.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { recruitingErrorResponse } from "../_lib";
import { createOfferTemplateBody } from "./bodies";

export const runtime = "nodejs";

/**
 * Offer-template collection: GET lists templates, POST creates one
 * (manage gate in the service). 404s while hrm, hrmRecruiting, or
 * hrmOfferSigning is off — the Setup surface hides with the same switch.
 */
async function depthGate(orgId: string) {
  if (!(await isFeatureEnabled(orgId, "hrm"))) return false;
  if (!(await isFeatureEnabled(orgId, "hrmRecruiting"))) return false;
  return isFeatureEnabled(orgId, "hrmOfferSigning");
}

export async function GET(req: Request) {
  const gate = await guardPermission("hrm.recruiting.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await depthGate(gate.user.orgId))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    const includeInactive = new URL(req.url).searchParams.get("includeInactive") === "1";
    const templates = await listOfferTemplates({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      includeInactive,
    });
    return NextResponse.json({ templates });
  } catch (e) {
    return recruitingErrorResponse(e);
  }
}

export async function POST(req: Request) {
  const gate = await guardPermission("hrm.recruiting.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await depthGate(gate.user.orgId))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, createOfferTemplateBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const template = await createOfferTemplate({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      name: body.name,
      bodyTemplate: body.bodyTemplate,
      clauses: body.clauses,
      approvalRequired: body.approvalRequired,
    });
    return NextResponse.json({ template }, { status: 201 });
  } catch (e) {
    return recruitingErrorResponse(e);
  }
}
