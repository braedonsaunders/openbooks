import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { recordConsent, withdrawConsent } from "@openbooks/engine/src/hrm/recruiting/retention.ts";
import { guardPermission } from "../../../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../../../lib/features";
import { recruitingErrorResponse } from "../../../_lib";
import { recordConsentBody, withdrawConsentBody } from "./bodies";
import { z } from "zod";

export const runtime = "nodejs";

const consentActionBody = z.union([withdrawConsentBody, recordConsentBody]);

/**
 * Candidate consents: POST records (or re-grants) consent for a purpose,
 * POST with action withdraw withdraws it (the row stays as evidence).
 * 404s while hrm, hrmRecruiting, or hrmCandidateRetention is off.
 */
async function depthGate(orgId: string) {
  if (!(await isFeatureEnabled(orgId, "hrm"))) return false;
  if (!(await isFeatureEnabled(orgId, "hrmRecruiting"))) return false;
  return isFeatureEnabled(orgId, "hrmCandidateRetention");
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.recruiting.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await depthGate(gate.user.orgId))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await params;
  const parsedBody = await parseJsonBody(req, consentActionBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    if ("action" in body && body.action === "withdraw") {
      await withdrawConsent({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        candidateId: id,
        purpose: body.purpose,
      });
      return NextResponse.json({ withdrawn: id });
    }
    const consent = await recordConsent({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      candidateId: id,
      purpose: body.purpose,
      source: "source" in body ? body.source : undefined,
      expiresAt: "expiresAt" in body ? body.expiresAt : undefined,
    });
    return NextResponse.json({ consent }, { status: 201 });
  } catch (e) {
    return recruitingErrorResponse(e);
  }
}
