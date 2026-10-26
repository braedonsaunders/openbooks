import { z } from "zod";
import { NextResponse } from "next/server";
import {
  readRoeSubsequentServiceContext,
  saveRoeSubsequentService,
} from "@openbooks/engine/payroll/canada/roe-subsequent-service";
import { PayrollError } from "@openbooks/engine/payroll/error";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { isoDate, uuidId } from "@/lib/api/json-schema";
export const dynamic = "force-dynamic";
const subject = z.strictObject({
  employeePartyId: uuidId,
  employmentId: uuidId,
  subsidiaryId: uuidId,
  precedingEventId: uuidId,
});
const query = subject.extend({ sourceFileId: uuidId.optional() });
const body = subject.extend({
  firstDayWorked: isoDate(),
  sourceFileId: uuidId,
  sourceVersionId: uuidId,
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceReference: z.string().trim().min(1).max(2000),
  reason: z.string().trim().min(1).max(2000),
  expectedId: uuidId.nullable(),
  expectedUpdatedAt: z.string().nullable(),
});
export const GET = defineRoute({
  permission: "payroll.read",
  feature: "payroll",
  handler: async ({ request, authz }) => {
    const parsed = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success)
      return NextResponse.json(
        { error: "Choose the original event, employment and legal employer" },
        { status: 422 },
      );
    const { precedingEventId, sourceFileId, ...employee } = parsed.data;
    try {
      return NextResponse.json(
        await readRoeSubsequentServiceContext(
          {
            ...employee,
            eventId: precedingEventId,
            orgId: authz.user.orgId,
            actorId: authz.user.id,
            allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
          },
          precedingEventId,
          sourceFileId,
        ),
      );
    } catch (error) {
      return apiErrorResponse(error, {
        request,
        ...(error instanceof PayrollError ? { safeStatus: 422 } : {}),
      });
    }
  },
});
export const POST = defineRoute({
  permission: "payroll.run",
  feature: "payroll",
  body,
  invalidBodyStatus: 422,
  handler: async ({ request, authz, body: input }) => {
    const { employeePartyId, employmentId, subsidiaryId, ...evidence } = input;
    try {
      return NextResponse.json({
        record: await saveRoeSubsequentService(
          {
            employeePartyId,
            employmentId,
            subsidiaryId,
            eventId: evidence.precedingEventId,
            orgId: authz.user.orgId,
            actorId: authz.user.id,
            allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
          },
          evidence,
        ),
      });
    } catch (error) {
      return apiErrorResponse(error, {
        request,
        ...(error instanceof PayrollError ? { safeStatus: 422 } : {}),
      });
    }
  },
});
