import { z } from "zod";
import { NextResponse } from "next/server";
import {
  importRoePriorPeriod,
  qualifyRoeLine,
  readRoeHistoricalEvidence,
  withdrawRoeLineEvidence,
} from "@openbooks/engine/payroll/roe-history";
import { PayrollError } from "@openbooks/engine/payroll/error";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { uuidId, isoDate } from "@/lib/api/json-schema";
export const dynamic = "force-dynamic";
const subject = z.strictObject({
  employeePartyId: uuidId,
  employmentId: uuidId,
  subsidiaryId: uuidId,
});
const source = {
  sourceFileId: uuidId,
  sourceVersionId: uuidId,
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceReference: z.string().trim().min(1).max(2000),
  insuranceReference: z.string().trim().min(1).max(2000),
  hoursReference: z.string().trim().min(1).max(2000),
  reason: z.string().trim().min(1).max(2000),
  expectedId: uuidId.nullable(),
  expectedUpdatedAt: z.string().nullable(),
};
const review = subject
  .extend({ periodFrom: z.string().optional(), periodTo: z.string().optional() })
  .refine((value) => (value.periodFrom === undefined) === (value.periodTo === undefined), {
    message: "Select both reporting range dates",
  });
const decimal = z.union([z.string(), z.number(), z.null()]);
const period = z.strictObject({
  ...source,
  filingAccountId: uuidId,
  payScheduleId: uuidId,
  frequency: z.enum(["weekly", "biweekly", "semi_monthly", "monthly"]),
  periodStart: z.string(),
  periodEnd: z.string(),
  payDate: z.string().nullable(),
  earnedFrom: z.string().nullable(),
  earnedTo: z.string().nullable(),
  insurableEarnings: decimal,
  insurableHours: decimal,
  nilPeriod: z.boolean(),
});
const line = z.strictObject({
  ...source,
  payStubLineId: uuidId,
  reportPeriodStart: isoDate(),
  reportPeriodEnd: isoDate(),
  earnedFrom: isoDate().nullable(),
  earnedTo: isoDate().nullable(),
  isInsurable: z.boolean(),
  insurableHours: decimal,
  reportingBasis: z.enum(["service", "separation_payment"]).optional(),
  separationEventId: uuidId.nullable().optional(),
  separationPaymentId: uuidId.nullable().optional(),
  separationBlock: z.enum(["17A", "17C"]).nullable().optional(),
  separationCategoryCode: z.string().nullable().optional(),
});
const body = z.discriminatedUnion("kind", [
  subject.extend({ kind: z.literal("period"), evidence: period }),
  subject.extend({ kind: z.literal("line"), evidence: line }),
]);
export const GET = defineRoute({
  permission: "payroll.read",
  feature: "payroll",
  handler: async ({ request, authz }) => {
    const parsed = review.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success)
      return NextResponse.json(
        {
          error:
            "Choose the native employee, employment and employer to review ROE reporting evidence",
        },
        { status: 422 },
      );
    const { periodFrom, periodTo, ...employee } = parsed.data;
    try {
      return NextResponse.json(
        await readRoeHistoricalEvidence(
          {
            ...employee,
            orgId: authz.user.orgId,
            actorId: authz.user.id,
            allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
          },
          periodFrom !== undefined && periodTo !== undefined ? { periodFrom, periodTo } : undefined,
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
    const scope = {
      employeePartyId: input.employeePartyId,
      employmentId: input.employmentId,
      subsidiaryId: input.subsidiaryId,
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
    };
    try {
      return NextResponse.json({
        record:
          input.kind === "period"
            ? await importRoePriorPeriod(scope, input.evidence)
            : await qualifyRoeLine(scope, input.evidence),
      });
    } catch (error) {
      return apiErrorResponse(error, {
        request,
        ...(error instanceof PayrollError ? { safeStatus: 422 } : {}),
      });
    }
  },
});
const withdrawal = subject.extend({
  expectedId: uuidId,
  expectedUpdatedAt: z.string().min(1),
  reason: z.string().trim().min(1).max(2000),
});
export const DELETE = defineRoute({
  permission: "payroll.run",
  feature: "payroll",
  body: withdrawal,
  invalidBodyStatus: 422,
  handler: async ({ request, authz, body: input }) => {
    const { expectedId, expectedUpdatedAt, reason, ...employee } = input;
    try {
      await withdrawRoeLineEvidence(
        {
          ...employee,
          orgId: authz.user.orgId,
          actorId: authz.user.id,
          allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
        },
        { expectedId, expectedUpdatedAt, reason },
      );
      return NextResponse.json({ withdrawn: true });
    } catch (error) {
      return apiErrorResponse(error, {
        request,
        ...(error instanceof PayrollError ? { safeStatus: 422 } : {}),
      });
    }
  },
});
