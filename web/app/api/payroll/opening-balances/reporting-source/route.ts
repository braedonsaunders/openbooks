import { z } from "zod";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { isoDate, uuidId } from "@/lib/api/json-schema";
import { canonicalNonNegativeDecimal } from "@openbooks/engine/money/decimal";
import { PayrollError } from "@openbooks/engine/payroll/error";
import {
  qualifyCanadianOpeningReportingSource,
  readCanadianOpeningReportingSourceContext,
} from "@openbooks/engine/payroll/canada/opening-reporting-authority";

export const dynamic = "force-dynamic";
const query = z.strictObject({
  employeePartyId: uuidId,
  taxYear: z
    .string()
    .regex(/^\d{4}$/)
    .transform(Number),
  sourceFileId: uuidId.optional(),
});
const decimal = z
  .string()
  .min(1)
  .max(40)
  .refine(
    (value) => canonicalNonNegativeDecimal(value, 4) !== null,
    "Enter an exact non-negative decimal with at most four decimal places",
  );
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const province = z.enum([
  "AB",
  "BC",
  "MB",
  "NB",
  "NL",
  "NS",
  "NT",
  "NU",
  "ON",
  "PE",
  "QC",
  "SK",
  "YT",
  "ZZ",
]);
const children = z.strictObject({
  components: z.array(z.strictObject({ component_id: uuidId, ytd_amount: decimal })).max(1000),
  programBases: z
    .array(z.strictObject({ program_key: z.string().min(1).max(100), insurable_ytd: decimal }))
    .max(1000),
  accountBases: z
    .array(
      z.strictObject({
        program_key: z.string().min(1).max(100),
        filing_account_id: uuidId,
        region: province.nullable(),
        insurable_ytd: decimal,
      }),
    )
    .max(1000),
  suiStates: z
    .array(z.strictObject({ state: z.string().regex(/^[A-Z]{2}$/), insurable_ytd: decimal }))
    .max(1000),
});
const body = z.strictObject({
  openingBalanceId: uuidId,
  requestId: uuidId,
  expectedLevyAuthorityId: uuidId,
  expectedLevyAllocationSha256: digest,
  expectedOpeningSha256: digest,
  expectedOpeningChildrenSha256: digest,
  sourceFileId: uuidId,
  sourceVersionId: uuidId,
  sourceSha256: digest,
  sourceReference: z.string().trim().min(1).max(2000),
  reason: z.string().trim().min(1).max(2000),
  allocations: z
    .array(
      z.strictObject({
        sourceOrdinal: z.number().int().min(1).max(2147483647),
        firstCoveredPayDate: isoDate(),
        filingAccountId: uuidId,
        province,
        annualAmounts: z.record(z.string().min(1).max(100), decimal),
        children,
        reportableBases: z.strictObject({ ei: decimal, cpp: decimal, qpip: decimal }),
      }),
    )
    .min(1)
    .max(1000),
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
        await readCanadianOpeningReportingSourceContext({
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
        record: await qualifyCanadianOpeningReportingSource({
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
