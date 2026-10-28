import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { listTemplateDocuments, saveTemplateDocument } from "@openbooks/engine/hrm/performance";
import { performanceErrorResponse } from "../../review-cycles/_lib";
import { saveReviewTemplateBody } from "../bodies";
export const runtime = "nodejs";
export const GET = defineRoute({
  public: "session",
  feature: "hrmPerformance",
  handler: async ({ authz }) => {
    try {
      return NextResponse.json({
        templates: await listTemplateDocuments({
          orgId: authz.user.orgId,
          actorId: authz.user.id,
        }),
      });
    } catch (error) {
      return performanceErrorResponse(error);
    }
  },
});
export const POST = defineRoute({
  public: "session",
  feature: "hrmPerformance",
  scope: "unrestricted",
  body: saveReviewTemplateBody,
  handler: async ({ authz, body }) => {
    try {
      return NextResponse.json({
        template: await saveTemplateDocument({
          ...body,
          orgId: authz.user.orgId,
          actorId: authz.user.id,
        }),
      });
    } catch (error) {
      return performanceErrorResponse(error);
    }
  },
});
