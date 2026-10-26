import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import {
  readV1JsonObject,
  requireV1IdempotencyKey,
  withV1Request,
} from "../../../../../lib/api/v1-request";
import {
  listApplicationRevaluationExposures,
  recordApplicationClosingFxRateEvidence,
} from "../../../../../lib/application/close";

const currencyCode = z.string().regex(/^[A-Z]{3}$/);

const recordBody = z.looseObject({
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
});

export const runtime = "nodejs";

/**
 * POST /api/v1/close/revaluation-rate-evidence — record one closing rate for
 * an exact FX position. The Idempotency-Key header is the recording's single
 * replay identity; there is no second request key in the body.
 * GET lists the selected book/period/entity exposures and their recorded
 * rates.
 */
async function handleV1POST(request: Request): Promise<NextResponse> {
  return withV1Request(
    request,
    "api/v1/close/revaluation-rate-evidence",
    async (_auth, context) => {
      const body = recordBody.parse(await readV1JsonObject(request));
      const outcome = await recordApplicationClosingFxRateEvidence(context, {
        ...body,
        idempotencyKey: requireV1IdempotencyKey(request),
      });
      return {
        status: outcome.replayed ? 200 : 201,
        body: outcome.result,
        replayed: outcome.replayed,
      };
    },
  );
}

async function handleV1GET(request: Request): Promise<NextResponse> {
  return withV1Request(
    request,
    "api/v1/close/revaluation-rate-evidence",
    async (_auth, context) => {
      const search = new URL(request.url).searchParams;
      const periodId = search.get("periodId") ?? "";
      const bookId = search.get("bookId") ?? "";
      if (!uuidString().safeParse(periodId).success || !uuidString().safeParse(bookId).success) {
        return {
          status: 400,
          body: { error: "Choose the close period and book to load FX exposures for." },
          replayed: false,
        };
      }
      const subsidiaryIds = (search.get("subsidiaryIds") ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      const exposures = await listApplicationRevaluationExposures(context, {
        periodId,
        bookId,
        subsidiaryIds: subsidiaryIds.length > 0 ? subsidiaryIds : undefined,
      });
      return { status: 200, body: { exposures }, replayed: false };
    },
  );
}

export const POST = defineRoute({
  public: "token",
  handler: ({ request }) => handleV1POST(request),
});

export const GET = defineRoute({
  public: "token",
  handler: ({ request }) => handleV1GET(request),
});
