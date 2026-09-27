import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/src/platform/db.ts";
import {
  createClassification,
  listClassifications,
} from "@openbooks/engine/src/hrm/construction/classifications.ts";
import { constructionErrorResponse } from "../_lib";
import { createClassificationBody } from "../bodies";
/** Work classifications: the org's trade taxonomy (Setup registry mirrors this). */
export const GET = defineRoute({
  permission: "hrm.construction.read",
  feature: "hrmConstructionCompliance",
  handler: async ({ authz: gate }) => {
    try {
      const classifications = await listClassifications(
        db,
        gate.user.orgId,
        gate.user.id,
      );
      return NextResponse.json({ classifications });
    } catch (e) {
      return constructionErrorResponse(e);
    }
  },
});
export const POST = defineRoute({
  permission: "hrm.construction.manage",
  feature: "hrmConstructionCompliance",
  body: createClassificationBody,
  handler: async ({ request: _req, authz: gate, body }) => {
    try {
      const classification = await createClassification(db, {
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        ...body,
      });
      return NextResponse.json({ classification }, { status: 201 });
    } catch (e) {
      return constructionErrorResponse(e);
    }
  },
});
