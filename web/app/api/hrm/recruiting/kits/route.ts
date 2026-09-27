import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  createKit,
  listKits,
} from "@openbooks/engine/src/hrm/recruiting/kits.ts";

import { recruitingErrorResponse } from "../_lib";
import { createKitBody } from "./bodies";

export const runtime = "nodejs";

/**
 * Interview-kit collection: GET lists kits, POST creates one (manage gate
 * in the service). 404s while hrm, hrmRecruiting, or hrmStructuredInterviews
 * is off — the Setup surface hides with the same switch.
 */
export const GET = defineRoute({
  permission: "hrm.recruiting.read",
  feature: "hrmStructuredInterviews",
  handler: async ({ request: req, authz: gate }) => {
    try {
      const includeInactive =
        new URL(req.url).searchParams.get("includeInactive") === "1";
      const kits = await listKits({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        includeInactive,
      });
      return NextResponse.json({ kits });
    } catch (e) {
      return recruitingErrorResponse(e);
    }
  },
});

export const POST = defineRoute({
  permission: "hrm.recruiting.manage",
  feature: "hrmStructuredInterviews",
  body: createKitBody,
  handler: async ({ authz: gate, body: body }) => {
    try {
      const kit = await createKit({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        name: body.name,
        pipelineStageId: body.pipelineStageId,
        instructions: body.instructions,
        ratingScale: body.ratingScale,
      });
      return NextResponse.json({ kit }, { status: 201 });
    } catch (e) {
      return recruitingErrorResponse(e);
    }
  },
});
