import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  createJobFamily,
  listJobFamilies,
} from "@openbooks/engine/src/hrm/compensation/architecture.ts";

import { compensationErrorResponse } from "../compensation/_lib";
import { createFamilyBody } from "../compensation/bodies";

export const runtime = "nodejs";

/**
 * Job families. GET lists through the compensation read gate; POST
 * authors through the manage gate. Gated on hrmCompensation — with only
 * the parent on, the org gets architecture and bands; cycles, plans and
 * transparency are their own opt-ins. The client checks res.ok before
 * parsing.
 */
export const GET = defineRoute({
  permission: "hrm.compensation.read",
  feature: "hrmCompensation",
  handler: async ({ request: req, authz: gate }) => {
    const includeInactive =
      new URL(req.url).searchParams.get("includeInactive") === "1";
    try {
      const families = await listJobFamilies({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        includeInactive,
      });
      return NextResponse.json({ families });
    } catch (e) {
      return compensationErrorResponse(e);
    }
  },
});

export const POST = defineRoute({
  permission: "hrm.compensation.manage",
  feature: "hrmCompensation",
  body: createFamilyBody,
  handler: async ({ request: req, authz: gate, body: body }) => {
    try {
      const family = await createJobFamily({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        code: body.code,
        name: body.name,
        description: body.description ?? null,
      });
      return NextResponse.json({ family }, { status: 201 });
    } catch (e) {
      return compensationErrorResponse(e);
    }
  },
});
