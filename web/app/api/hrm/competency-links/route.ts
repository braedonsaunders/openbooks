import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { NextResponse } from "next/server";
import {
  linkCompetency,
  setSectionCompetency,
} from "@openbooks/engine/src/hrm/performance/competencies.ts";

import { isFeatureEnabled } from "../../../../lib/features";
import { performanceErrorResponse } from "../review-cycles/_lib";
import { linkCompetencyBody } from "../competency-frameworks/bodies";

export const runtime = "nodejs";

/**
 * Competency links. POST links a competency to a job level, position,
 * or review template section (the target must exist — refused by name
 * otherwise), or attaches a competency to a template section so the
 * review renders its level expectations inline. The client checks
 * res.ok before parsing.
 */
export const POST = defineRoute({
  public: "session",
  body: linkCompetencyBody,
  handler: async ({ request: req, authz: authz, body: body }) => {
    if (
      !(await isFeatureEnabled(authz.user.orgId, "hrm")) ||
      !(await isFeatureEnabled(authz.user.orgId, "hrmPerformance")) ||
      !(await isFeatureEnabled(authz.user.orgId, "hrmCompetencies"))
    ) {
      return notFound("record");
    }

    try {
      if (body.action === "link") {
        await linkCompetency({
          orgId: authz.user.orgId,
          actorId: authz.user.id,
          competencyId: body.competencyId,
          targetKind: body.targetKind,
          targetId: body.targetId,
        });
        return NextResponse.json({ ok: true }, { status: 201 });
      }
      await setSectionCompetency({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        sectionId: body.sectionId,
        competencyId: body.competencyId,
      });
      return NextResponse.json({ ok: true });
    } catch (e) {
      return performanceErrorResponse(e);
    }
  },
});
