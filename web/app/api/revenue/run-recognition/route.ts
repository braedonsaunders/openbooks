import { NextResponse } from "next/server";
import { getLocale } from "next-intl/server";
import { z } from "zod";
import { runRevenueRecognition } from "@openbooks/engine/revenue/recognition";
import { periodDisplayLabel } from "@openbooks/engine/periods/period-policy";
import { syncProjectRevenueContracts } from "@openbooks/engine/projects/revenue";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import { defineRoute } from "@/lib/api/route";
import { revenueRecognitionErrorResponse } from "@/lib/revenue-recognition-error";
import { isoDate, uuidId } from "@/lib/api/json";

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
    // Snapshot the authorization set once and carry that exact policy through
    // both project synchronization and recognition posting. `null` means
    // unrestricted; an empty Set is a restricted caller with no permitted legal
    // entities and must not reach either engine boundary.
    const allowedSubsidiaryIds =
      gate.allowedSubsidiaryIds === null ? undefined : [...gate.allowedSubsidiaryIds];

    if (allowedSubsidiaryIds?.length === 0) {
      return NextResponse.json({
        posted: 0,
        skipped: 0,
        totalAmount: "0",
        entries: [],
        problems: [],
      });
    }

    try {
      // A reviewed confirmation must validate the exact schedule lines the
      // operator saw. Project synchronization rebuilds those lines, so defer it
      // to the next unreviewed run; the preview already warns about catch-up
      // lines waiting for that run.
      // The engine owns the Projects gate and names its skip: an unreviewed run
      // with project work waiting but no sync must warn, never post zero project
      // progress in silence.
      const projectSync = body.fingerprint
        ? null
        : await syncProjectRevenueContracts(
            user.orgId,
            user.id,
            asOfDate,
            undefined,
            allowedSubsidiaryIds,
          );
      const result = await runRevenueRecognition(
        user.orgId,
        asOfDate,
        user.id,
        body.obligationId,
        allowedSubsidiaryIds,
        // A confirmed run carries the fingerprint of exactly what the operator
        // reviewed; the engine re-derives that set and refuses before writing
        // anything if it moved.
        body.fingerprint
          ? {
              fingerprint: body.fingerprint,
              scope: {
                asOfDate,
                obligationId: body.obligationId,
                contractId: body.contractId,
                bookId: body.bookId,
                periodId: body.periodId,
                allowedSubsidiaryIds,
              },
            }
          : undefined,
      );
      if (projectSync) {
        result.problems.push(...projectSync.problems);
        if (projectSync.skipped) result.problems.push(projectSync.skipped);
      }
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
