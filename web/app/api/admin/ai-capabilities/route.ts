import { defineRoute } from "@/lib/api/route";

import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@openbooks/engine/platform/db";
import {
  listCapabilities,
  syncCapabilitiesForOrg,
  updateCapabilityForOrg,
} from "@openbooks/engine/hrm/ai/governance";
import { aiRailsErrorResponse } from "@/lib/ai-rails";

export const runtime = "nodejs";

const patchBody = z
  .object({
    key: z.string().min(1),
    autonomy: z.enum(["read_only", "draft", "propose", "act_with_confirmation"]).optional(),
    reviewerRole: z.string().max(200).nullable().optional(),
    markReviewed: z.boolean().optional(),
  })
  .strict();

/**
 * AI capability registry mirror. GET lists the org rows; PATCH edits
 * autonomy DOWN only (raises refuse by name), the reviewer, or records a
 * review. Each capability's enabled state follows the module that owns
 * its data (Company Settings → Features). POST syncs the mirror from the
 * code registry. Ledger under the setup grant.
 */
export const GET = defineRoute({
  permission: "admin.setup.manage",
  feature: "aiGovernanceLedger",
  handler: async ({ authz }) => {
    try {
      const capabilities = await listCapabilities(db, authz.user.orgId);
      return NextResponse.json({ capabilities });
    } catch (e) {
      return aiRailsErrorResponse(e);
    }
  },
});

export const PATCH = defineRoute({
  permission: "admin.setup.manage",
  feature: "aiGovernanceLedger",
  body: patchBody,
  handler: async ({ body, authz: gate }) => {
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
  },
});

export const POST = defineRoute({
  permission: "admin.setup.manage",
  feature: "aiGovernanceLedger",
  handler: async ({ authz }) => {
    try {
      const seeded = await syncCapabilitiesForOrg({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
      });
      return NextResponse.json({ seeded });
    } catch (e) {
      return aiRailsErrorResponse(e);
    }
  },
});
