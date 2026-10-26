import { z } from "zod";
import { NextResponse } from "next/server";
import {
  readRoeSeparationFactsContext,
  saveRoeSeparationFacts,
} from "@openbooks/engine/payroll/roe-separation-facts";
import { PayrollError } from "@openbooks/engine/payroll/error";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { uuidId } from "@/lib/api/json-schema";
export const dynamic = "force-dynamic";
const query = z.strictObject({
  employeePartyId: uuidId,
  eventId: uuidId.optional(),
  newEvent: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
  employmentId: uuidId.optional(),
  subsidiaryId: uuidId.optional(),
});
const body = z.strictObject({
  employeePartyId: uuidId,
  employmentId: uuidId,
  subsidiaryId: uuidId,
  firstDayWorked: z.string().nullable(),
  interruptionOn: z.string(),
  lastInsurableEarningsOn: z.string(),
  salaryContinuanceEndOn: z.string().nullable(),
  sourceReference: z.string().trim().min(1).max(2000),
  reason: z.string().trim().min(1).max(2000),
  status: z.enum(["draft", "confirmed"]),
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
        { error: "Choose a native employee to review separation facts" },
        { status: 422 },
      );
    try {
      return NextResponse.json(
        await readRoeSeparationFactsContext({
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
        record: await saveRoeSeparationFacts({
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
