import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { applicationContextFromSession } from "@/lib/application/context";
import {
  listApplicationRevaluationExposures,
  recordApplicationClosingFxRateEvidence,
} from "@/lib/application/close";

export const runtime = "nodejs";

const currencyCode = z.string().regex(/^[A-Z]{3}$/);

const recordBodySchema = z
  .object({
    bookId: uuidString(),
    subsidiaryId: uuidString(),
    periodId: uuidString(),
    accountId: uuidString(),
    transactionCurrency: currencyCode,
    measurementCurrency: currencyCode,
    rateDate: z.string().date().optional(),
    rate: z.string().min(1),
    source: z.string().min(1),
    reason: z.string().min(1),
    expectedCurrentId: uuidString().nullable(),
    requestId: uuidString(),
  })
  .strict();

/**
 * The close run's selected-entity FX exposures: the revaluation engine's own
 * positions for the run's book and period, with the recorded closing rate
 * behind each one. Recording a rate here prepares the next revaluation run
 * for that exact position; it posts nothing and never touches the
 * organization's exchange rates.
 */
export const GET = defineRoute({
  permission: "close.run",
  feature: "multiCurrency",
  handler: async ({ request, authz }) => {
    const search = new URL(request.url).searchParams;
    const periodId = search.get("periodId") ?? "";
    const bookId = search.get("bookId") ?? "";
    if (!uuidString().safeParse(periodId).success || !uuidString().safeParse(bookId).success) {
      return NextResponse.json(
        { error: "Choose the close period and book to load FX exposures for." },
        { status: 400 },
      );
    }
    const subsidiaryIds = (search.get("subsidiaryIds") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const context = applicationContextFromSession(
      authz,
      "api",
      request.headers.get("x-request-id") ?? "",
    );
    const exposures = await listApplicationRevaluationExposures(context, {
      periodId,
      bookId,
      subsidiaryIds: subsidiaryIds.length > 0 ? subsidiaryIds : undefined,
    });
    return NextResponse.json({ exposures });
  },
});

export const POST = defineRoute({
  permission: "close.run",
  feature: "multiCurrency",
  body: recordBodySchema,
  handler: async ({ authz, body }) => {
    const context = applicationContextFromSession(authz, "api", body.requestId);
    const outcome = await recordApplicationClosingFxRateEvidence(context, {
      ...body,
      idempotencyKey: body.requestId,
    });
    return NextResponse.json({ evidence: outcome.result, replayed: outcome.replayed });
  },
});
