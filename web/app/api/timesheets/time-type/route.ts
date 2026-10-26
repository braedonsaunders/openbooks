import { z } from "zod";
import { NextResponse } from "next/server";
import { withOrgTransaction } from "@openbooks/engine/platform/db";
import { correctUnapprovedTimeType } from "@openbooks/engine/projects/time-type-correction";
import { TimeWorkTargetError } from "@openbooks/engine/projects/time-work-target";
import { authorizeTimeWorkspace, timeWorkFamily } from "@/lib/time-workspace";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { isoDate, uuidId } from "@/lib/api/json";
import { loadWeek } from "../_lib";

const revision = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
export const runtime = "nodejs";
export const POST = defineRoute({
  authorize: authorizeTimeWorkspace("time.manage"),
  feature: {
    none: "The native time command locks the actual workspace and project feature gates.",
  },
  body: z.strictObject({
    employeePartyId: uuidId,
    weekStart: isoDate(),
    entryId: uuidId,
    expectedUpdatedAt: revision,
    timeTypeId: uuidId,
    timeTypeUpdatedAt: revision,
    commandId: uuidId,
    reason: z.string().trim().min(10).max(500),
  }),
  handler: async ({ request, authz, body }) => {
    try {
      return await withOrgTransaction(authz.user.orgId, async () => {
        const result = await correctUnapprovedTimeType({
          ...body,
          orgId: authz.user.orgId,
          actorId: authz.user.id,
          requestedScope: authz.allowedSubsidiaryIds,
          workFamily: timeWorkFamily(request),
        });
        return NextResponse.json({
          ...(await loadWeek(
            authz.user.orgId,
            body.employeePartyId,
            body.weekStart,
            authz.allowedSubsidiaryIds,
          )),
          correction: result,
        });
      });
    } catch (error) {
      if (error instanceof TimeWorkTargetError) return apiErrorResponse(error);
      throw error;
    }
  },
});
