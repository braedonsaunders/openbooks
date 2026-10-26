import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import {
  correctEmploymentStart,
  EmploymentStartCorrectionError,
} from "@openbooks/engine/hrm/change-requests";
import { HrmAuthorizationError } from "@openbooks/engine/hrm/authorization";
import { hrmAuthorizationResponse } from "../../../../../../lib/api/record-not-found";

export const runtime = "nodejs";

/**
 * Correct a wrongly recorded employment start. The engine moves the first
 * interval and the records that began with it, refuses when committed pay
 * runs contradict the corrected date, and audits the correction.
 */
export const POST = defineRoute({
  permission: "hrm.employment.manage",
  feature: "hrm",
  params: z.object({ id: uuidString() }),
  body: z
    .object({
      correctedStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      reason: z.string().trim().min(10).max(500),
    })
    .strict(),
  handler: async ({ authz, params, body }) => {
    try {
      const result = await correctEmploymentStart({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        employmentId: params.id,
        correctedStart: body.correctedStart,
        reason: body.reason,
      });
      return NextResponse.json({ ok: true, ...result });
    } catch (error) {
      if (error instanceof EmploymentStartCorrectionError) {
        return NextResponse.json({ error: error.message }, { status: 422 });
      }
      if (error instanceof HrmAuthorizationError) return hrmAuthorizationResponse(error);
      return apiErrorResponse(error);
    }
  },
});
