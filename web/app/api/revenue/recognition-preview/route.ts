import { NextResponse } from "next/server";
import { getLocale } from "next-intl/server";
import { z } from "zod";
import { periodDisplayLabel } from "@openbooks/engine/periods/period-policy";
import { defineRoute } from "@/lib/api/route";
import { revenueRecognitionErrorResponse } from "@/lib/revenue-recognition-error";
import { buildRevenueRecognitionPreview } from "@/lib/revenue/recognition-actions";

export const runtime = "nodejs";

// Read-only: the confirmation fingerprint is consumed only by the run route.
const previewBody = z.object({
  asOfDate: z.string().optional().nullable(),
  obligationId: z.string().optional().nullable(),
  contractId: z.string().optional().nullable(),
  bookId: z.string().optional().nullable(),
  periodId: z.string().optional().nullable(),
});

function bad(error: string, field?: string, status = 422) {
  return NextResponse.json({ error, ...(field ? { field } : {}) }, { status });
}

export const POST = defineRoute({
  permission: "ar.post",
  feature: "revenueRecognition",
  body: previewBody,
  invalidBodyStatus: 422,
  handler: async ({ authz: gate, body }) => {
    try {
      const outcome = await buildRevenueRecognitionPreview(
        gate.user.orgId,
        gate.allowedSubsidiaryIds,
        body,
      );
      if (!outcome.ok) return bad(outcome.error, outcome.field);
      const locale = await getLocale();
      return NextResponse.json({
        ...outcome.preview,
        rows: outcome.preview.rows.map((row) => {
          const periodName = periodDisplayLabel(row.periodRef, locale);
          return {
            ...row,
            periodName,
            skipDetail: row.skipReason === "period_closed" ? periodName : row.skipDetail,
          };
        }),
      });
    } catch (error: unknown) {
      return revenueRecognitionErrorResponse(error, "Unable to preview revenue recognition.");
    }
  },
});
