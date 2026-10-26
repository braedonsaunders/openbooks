import { z } from "zod";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { uuidId } from "@/lib/api/json-schema";
import { PayrollError } from "@openbooks/engine/payroll/error";
import {
  readOpeningEmployerContext,
  qualifyOpeningEmployerAuthority,
} from "@openbooks/engine/payroll/opening-employer-authority";
export const dynamic = "force-dynamic";
const query = z.strictObject({
  employeePartyId: uuidId,
  taxYear: z
    .string()
    .regex(/^\d{4}$/)
    .transform(Number),
  sourceFileId: uuidId.optional(),
});
const body = z.strictObject({
  openingBalanceId: uuidId,
  subsidiaryId: uuidId,
  sourceFileId: uuidId,
  sourceVersionId: uuidId,
  expectedOpeningSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceReference: z.string().trim().min(1).max(2000),
  reason: z.string().trim().min(1).max(2000),
});
export const GET = defineRoute({
  permission: "payroll.read",
  feature: "payroll",
  handler: async ({ request, authz }) => {
    const parsed = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success)
      return NextResponse.json(
        { error: "Choose a native employee and opening year" },
        { status: 422 },
      );
    try {
      return NextResponse.json(
        await readOpeningEmployerContext({
          ...parsed.data,
          orgId: authz.user.orgId,
          actorId: authz.user.id,
          allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
        }),
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
    try {
      return NextResponse.json({
        record: await qualifyOpeningEmployerAuthority({
          ...input,
          orgId: authz.user.orgId,
          actorId: authz.user.id,
          allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
        }),
      });
    } catch (error) {
      return apiErrorResponse(error, {
        request,
        ...(error instanceof PayrollError ? { safeStatus: 422 } : {}),
      });
    }
  },
});
