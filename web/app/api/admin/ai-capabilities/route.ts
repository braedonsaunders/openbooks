import { defineRoute } from "@/lib/api/route";
import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@openbooks/engine/src/platform/db.ts";
import {
  listCapabilities,
  syncCapabilitiesForOrg,
  updateCapabilityForOrg,
} from "@openbooks/engine/src/hrm/ai/governance.ts";
import { aiRailsErrorResponse } from "../../../../lib/ai-rails";
import { guardPermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { notFound } from "@/lib/api/responses";


export const runtime = "nodejs";

const patchBody = z.object({
  key: z.string().min(1),
  autonomy: z.enum(["read_only", "draft", "propose", "act_with_confirmation"]).optional(),
  reviewerRole: z.string().max(200).nullable().optional(),
  markReviewed: z.boolean().optional(),
}).strict();

/**
 * AI capability registry mirror. GET lists the org rows; PATCH edits
 * autonomy DOWN only (raises refuse by name), the reviewer, or records a
 * review. Each capability's enabled state follows the module that owns
 * its data (Company Settings → Features). POST syncs the mirror from the
 * code registry. Ledger under the setup grant.
 */
async function legacyGET() {
  const gate = await guardPermission("admin.setup.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "aiGovernanceLedger"))) {
    return notFound("record");
  }
  try {
    const capabilities = await listCapabilities(db, gate.user.orgId);
    return NextResponse.json({ capabilities });
  } catch (e) {
    return aiRailsErrorResponse(e);
  }
}

async function legacyPATCH(req: Request) {
  const gate = await guardPermission("admin.setup.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "aiGovernanceLedger"))) {
    return notFound("record");
  }
  const parsedBody = await parseJsonBody(req, patchBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const capability = await updateCapabilityForOrg({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      key: body.key,
      autonomy: body.autonomy,
      reviewerRole: body.reviewerRole,
      markReviewed: body.markReviewed,
    });
    return NextResponse.json({ capability });
  } catch (e) {
    return aiRailsErrorResponse(e);
  }
}

async function legacyPOST() {
  const gate = await guardPermission("admin.setup.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "aiGovernanceLedger"))) {
    return notFound("record");
  }
  try {
    const seeded = await syncCapabilitiesForOrg({ orgId: gate.user.orgId, actorId: gate.user.id });
    return NextResponse.json({ seeded });
  } catch (e) {
    return aiRailsErrorResponse(e);
  }
}

export const GET = defineRoute({
  permission: "admin.setup.manage",
  feature: { none: "This endpoint has no single route-wide feature gate; its handler retains any action-specific feature checks." },
  handler: async () => legacyGET(),
});

export const PATCH = defineRoute({
  permission: "admin.setup.manage",
  feature: { none: "This endpoint has no single route-wide feature gate; its handler retains any action-specific feature checks." },
  body: patchBody,
  handler: async ({ request, body }) => {
    const replayHeaders = new Headers(request.headers);
    replayHeaders.delete("content-length");
    const replayRequest = new Request(request.url, { method: request.method, headers: replayHeaders, body: JSON.stringify(body), signal: request.signal });
    return legacyPATCH(replayRequest as never);
  },
});

export const POST = defineRoute({
  permission: "admin.setup.manage",
  feature: { none: "This endpoint has no single route-wide feature gate; its handler retains any action-specific feature checks." },
  handler: async () => legacyPOST(),
});
