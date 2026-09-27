import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  addSuccessionCandidate,
  removeSuccessionCandidate,
} from "@openbooks/engine/src/hrm/performance/talent.ts";
import { performanceErrorResponse } from "../../../review-cycles/_lib";
import { addSuccessionCandidateBody } from "../../../talent-reviews/bodies";
import { z } from "zod";
import { isUuid } from "../../../../../../lib/list-params";
const removeCandidateBody = z.object({
  candidateId: z.string().refine(isUuid, "must be a valid id"),
});
/**
 * Ranked succession candidates on one plan. POST appends at the next
 * rank; PATCH with a candidateId removes. HR-only. The client checks
 * res.ok before parsing.
 */
export const POST = defineRoute({
  permission: "hrm.performance.manage",
  feature: "hrmPerformance",
  body: addSuccessionCandidateBody,
  params: z.object({ id: z.string() }),
  handler: async ({ request: _req, authz, params, body }) => {
    const { id } = params;
    try {
      const candidate = await addSuccessionCandidate({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        planId: id,
        employmentId: body.employmentId,
        readiness: body.readiness,
        notes: body.notes ?? null,
      });
      return NextResponse.json({ candidate }, { status: 201 });
    } catch (e) {
      return performanceErrorResponse(e);
    }
  },
});
export const PATCH = defineRoute({
  permission: "hrm.performance.manage",
  feature: "hrmPerformance",
  body: removeCandidateBody,
  params: z.object({ id: z.string() }),
  handler: async ({ request: _req, authz, params, body }) => {
    const { id } = params;
    try {
      await removeSuccessionCandidate({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        planId: id,
        candidateId: body.candidateId,
      });
      return NextResponse.json({ ok: true });
    } catch (e) {
      return performanceErrorResponse(e);
    }
  },
});
