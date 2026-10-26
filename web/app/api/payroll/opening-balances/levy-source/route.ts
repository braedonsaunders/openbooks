import { z } from "zod";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { isoDate, uuidId } from "@/lib/api/json-schema";
import { PayrollError } from "@openbooks/engine/payroll/error";
import {
  qualifyOpeningLevySourceAuthority,
  readOpeningLevySourceContext,
  openingLevySourceRequiresAllocations,
} from "@openbooks/engine/payroll/opening-levy-source-authority";
import { correctOpeningLevySourceAuthority } from "@openbooks/engine/payroll/opening-levy-source-correction";

export const dynamic = "force-dynamic";
const query = z.strictObject({
  employeePartyId: uuidId,
  sourceFileId: uuidId.optional(),
  taxYear: z
    .string()
    .regex(/^\d{4}$/)
    .transform(Number),
});
const allocation = z.strictObject({
  programKey: z.enum(["ca_wcb", "ca_eht", "ca_cnt", "us_futa", "us_sui", "us_pa_lst"]),
  region: z.string().trim().min(2).max(2),
  subRegion: z.string().trim().max(32).optional(),
  filingAccountId: uuidId.nullable().optional(),
  federalAccountId: uuidId.nullable(),
  amount: z.string().trim().min(1).max(40),
});
const qualificationFields = {
  openingBalanceId: uuidId,
  expectedOpeningSha256: z.string().regex(/^[a-f0-9]{64}$/),
  expectedOpeningChildrenSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceFileId: uuidId,
  sourceVersionId: uuidId,
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceReference: z.string().trim().min(1).max(2000),
  originalCountry: z.string().regex(/^[A-Z]{2}$/),
  originalCurrency: z.string().regex(/^[A-Z]{3}$/),
  coverageStart: isoDate(),
  coverageEnd: isoDate(),
  coverageComplete: z.literal(true),
  allocations: z.array(allocation).max(1000),
  reason: z.string().trim().min(1).max(2000),
};
const body = z.strictObject(qualificationFields).superRefine((input, ctx) => {
  if (
    openingLevySourceRequiresAllocations(input.originalCountry) &&
    input.allocations.length === 0
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["allocations"],
      message: "Declare the complete original statutory levy allocations, including explicit zeros",
    });
  }
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
        await readOpeningLevySourceContext({
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
      const record = await qualifyOpeningLevySourceAuthority({
        ...input,
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      });
      return NextResponse.json({ record });
    } catch (error) {
      return apiErrorResponse(error, {
        request,
        ...(error instanceof PayrollError ? { safeStatus: 422 } : {}),
      });
    }
  },
});

const correctionBody = z
  .strictObject({
    ...qualificationFields,
    requestId: uuidId,
    expectedAuthorityId: uuidId,
    expectedAllocationSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .superRefine((input, ctx) => {
    if (
      openingLevySourceRequiresAllocations(input.originalCountry) &&
      input.allocations.length === 0
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["allocations"],
        message:
          "Declare the complete original statutory levy allocations, including explicit zeros",
      });
    }
  });

export const PATCH = defineRoute({
  permission: "payroll.manage",
  feature: "payroll",
  body: correctionBody,
  invalidBodyStatus: 422,
  handler: async ({ request, authz, body: input }) => {
    try {
      const record = await correctOpeningLevySourceAuthority({
        ...input,
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      });
      return NextResponse.json({ record });
    } catch (error) {
      return apiErrorResponse(error, {
        request,
        ...(error instanceof PayrollError ? { safeStatus: 422 } : {}),
      });
    }
  },
});
