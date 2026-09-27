import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { assignClassification } from "@openbooks/engine/src/hrm/construction/classifications.ts";
import { constructionErrorResponse } from "../_lib";
import { assignClassificationBody } from "../bodies";
/** Employment classifications: bitemporal assignment with history. */
export const POST = defineRoute({
  permission: "hrm.construction.manage",
  feature: "hrmConstructionCompliance",
  body: assignClassificationBody,
  handler: async ({ request: _req, authz: gate, body }) => {
    try {
      const assignment = await assignClassification(db, {
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        ...body,
      });
      return NextResponse.json({ assignment }, { status: 201 });
    } catch (e) {
      return constructionErrorResponse(e);
    }
  },
});
