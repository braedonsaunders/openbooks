import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  cancelEnrollment,
  changeEnrollment,
  endEnrollment,
} from "@openbooks/engine/src/hrm/benefits/enrollments.ts";

import { isUuid } from "../../../../../lib/list-params";
import { benefitsErrorResponse } from "../../benefits/_lib";
import { enrollmentPatchBody } from "../bodies";

export const runtime = "nodejs";

/**
 * Change, end or cancel coverage with hrm.benefits.manage and employment scope.
 * A change submits a successor through the plan's native Flow setting;
 * existing coverage remains active until the successor is approved.
 */
export const PATCH = defineRoute({
  permission: "hrm.benefits.manage",
  feature: "hrm",
  params: z.object({ id: z.string().min(1) }),
  body: enrollmentPatchBody,
  handler: async ({
    authz: gate,
    params: routeParams,
    body: body,
  }) => {
    const { id } = routeParams;
    if (!isUuid(id))
      return NextResponse.json(
        { error: "enrollment id must be a uuid" },
        { status: 400 },
      );

    const base = {
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      enrollmentId: id,
    };
    try {
      switch (body.action) {
        case "change": {
          const enrollment = await changeEnrollment({
            ...base,
            changeDate: body.changeDate,
            classKey: body.classKey,
            matchEligible: body.matchEligible,
            contributionTerms: body.contributionTerms,
            reason: body.reason,
          });
          return NextResponse.json({ enrollment });
        }
        case "end": {
          const enrollment = await endEnrollment({
            ...base,
            endedOn: body.endedOn ?? null,
            reason: body.reason,
          });
          return NextResponse.json({ enrollment });
        }
        case "cancel": {
          const enrollment = await cancelEnrollment({
            ...base,
            reason: body.reason,
          });
          return NextResponse.json({ enrollment });
        }
      }
    } catch (e) {
      return benefitsErrorResponse(e);
    }
  },
});
