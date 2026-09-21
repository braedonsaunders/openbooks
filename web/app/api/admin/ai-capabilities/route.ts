import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@openbooks/engine/src/platform/db.ts";
import {
  listCapabilities,
  syncCapabilitiesForOrg,
  updateCapability,
} from "@openbooks/engine/src/hrm/ai/governance.ts";
import { aiRailsErrorResponse } from "../../../../lib/ai-rails";
import { guardPermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";

export const runtime = "nodejs";

const patchBody = z.object({
  key: z.string().min(1),
  autonomy: z.enum(["read_only", "draft", "propose", "act_with_confirmation"]).optional(),
  reviewerRole: z.string().max(200).nullable().optional(),
  enabled: z.boolean().optional(),
  markReviewed: z.boolean().optional(),
});

/**
 * AI capability registry mirror. GET lists the org rows; PATCH edits
 * autonomy DOWN only (raises refuse by name), the reviewer, the enabled
 * flag, or records a review. POST syncs the mirror from the code
 * registry when a feature turns on. Ledger under the setup grant.
 */
export async function GET() {
  const gate = await guardPermission("admin.setup.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "aiGovernanceLedger"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    const capabilities = await listCapabilities(db, gate.user.orgId);
    return NextResponse.json({ capabilities });
  } catch (e) {
    return aiRailsErrorResponse(e);
  }
}

export async function PATCH(req: Request) {
  const gate = await guardPermission("admin.setup.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "aiGovernanceLedger"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, patchBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const capability = await updateCapability(db, {
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      key: body.key,
      autonomy: body.autonomy,
      reviewerRole: body.reviewerRole,
      enabled: body.enabled,
      markReviewed: body.markReviewed,
    });
    return NextResponse.json({ capability });
  } catch (e) {
    return aiRailsErrorResponse(e);
  }
}

export async function POST() {
  const gate = await guardPermission("admin.setup.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "aiGovernanceLedger"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    const seeded = await syncCapabilitiesForOrg({ orgId: gate.user.orgId, actorId: gate.user.id });
    return NextResponse.json({ seeded });
  } catch (e) {
    return aiRailsErrorResponse(e);
  }
}
