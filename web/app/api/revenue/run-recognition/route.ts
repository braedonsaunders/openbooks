import { NextResponse } from "next/server";
import { getLocale } from "next-intl/server";
import { z } from "zod";
import { periodDisplayLabel } from "@openbooks/engine/periods/period-policy";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import { defineRoute } from "@/lib/api/route";
import { revenueRecognitionErrorResponse } from "@/lib/revenue-recognition-error";
import { isoDate, uuidId } from "@/lib/api/json";
import { executeRevenueRecognitionRun } from "@/lib/revenue/recognition-actions";

export const runtime = "nodejs";

const scopedId = (label: string) =>
  z
    .string({ error: `invalid ${label}` })
    .refine((v) => uuidId.safeParse(v).success, `invalid ${label}`)
    .optional();

const runRecognitionBody = z.object({
  asOfDate: isoDate().optional(),
  obligationId: scopedId("obligation"),
  // Reviewed-run scope. Present only when the drawer confirms a preview;
  // the legacy immediate call sends none of it and behaves exactly as before.
  contractId: scopedId("contract"),
  bookId: scopedId("book"),
  periodId: scopedId("period"),
  fingerprint: z.string().min(1).optional(),
});

/**
 * Run revenue recognition: post every due, unposted schedule line through the
 * kernel (DR deferred / CR earned, origin='revenue_recognition'), idempotently.
 * Optional `obligationId` scopes the run to one obligation; `asOfDate` defaults
 * to today.
 */
export const POST = defineRoute({
  permission: "ar.post",
  feature: "revenueRecognition",
  body: runRecognitionBody,
  invalidBodyStatus: 422,
  handler: async ({ authz: gate, body }) => {
    const user = gate.user;
    const asOfDate = body.asOfDate ?? (await businessToday(user.orgId));
    try {
      const result = await executeRevenueRecognitionRun(
        user.orgId,
        user.id,
        gate.allowedSubsidiaryIds,
        {
          asOfDate,
          obligationId: body.obligationId,
          contractId: body.contractId,
          bookId: body.bookId,
          periodId: body.periodId,
          fingerprint: body.fingerprint,
        },
      );
      // Posted entries reach the drawer with their period labelled in the viewer's locale.
      const locale = await getLocale();
      return NextResponse.json({
        ...result,
        entries: result.entries.map((entry) => ({
          ...entry,
          period: periodDisplayLabel(entry.periodRef, locale),
        })),
      });
    } catch (e: unknown) {
      return revenueRecognitionErrorResponse(e, "Unable to run revenue recognition.");
    }
  },
});
