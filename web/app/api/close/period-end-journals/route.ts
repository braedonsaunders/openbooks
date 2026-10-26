import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { NextResponse } from "next/server";
import { getLocale } from "next-intl/server";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { PostingError } from "@openbooks/engine/journal/contracts";
import {
  generatePeriodEndJournals,
  periodEndJournalHistory,
  PeriodEndJournalError,
  previewPeriodEndJournals,
  reversePeriodEndJournals,
} from "@openbooks/engine/close/period-end-journals";
import { labelPeriodEndPreview } from "@/lib/close/period-labels";

export const runtime = "nodejs";

const previewQuerySchema = z
  .object({
    periodId: uuidString(),
    bookId: uuidString().optional(),
  })
  .strict();

const commandSchema = z
  .object({
    action: z.enum(["generate", "reverse"]),
    periodId: uuidString(),
    bookId: uuidString().optional(),
    reason: z.string().trim().min(10).max(500),
  })
  .strict();

function refusal(error: unknown, request: Request) {
  if (error instanceof PeriodEndJournalError || error instanceof PostingError) {
    return apiErrorResponse(error, {
      request,
      safeStatus: error instanceof PeriodEndJournalError && error.code === "forbidden" ? 403 : 422,
    });
  }
  return apiErrorResponse(error, { request });
}

/** The caller's legal entities: null is unrestricted; an empty set reads nothing. */
function subsidiaryScope(allowed: Set<string> | null): string[] | null {
  return allowed === null ? null : [...allowed];
}

/**
 * The fiscal year's period-end journals: what generating would post now per
 * legal entity (with the readiness problems that would refuse it) and every
 * generation of the year with its journals and reversals. `periodId` is any
 * period of the fiscal year, usually the close run's period.
 */
export const GET = defineRoute({
  permission: "close.read",
  feature: "periodEndJournals",
  handler: async ({ request, authz }) => {
    const search = new URL(request.url).searchParams;
    const parsed = previewQuerySchema.safeParse({
      periodId: search.get("periodId") ?? "",
      ...(search.get("bookId") ? { bookId: search.get("bookId") } : {}),
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Choose a period of the fiscal year to close (periodId)." },
        { status: 400 },
      );
    }
    try {
      const subsidiaryIds = subsidiaryScope(authz.allowedSubsidiaryIds);
      const preview = await previewPeriodEndJournals(authz.user.orgId, {
        ...parsed.data,
        subsidiaryIds,
      });
      const history = await periodEndJournalHistory(authz.user.orgId, {
        fiscalYear: preview.fiscalYear.fiscalYear,
        bookId: preview.book.id,
        subsidiaryIds,
      });
      return NextResponse.json({
        preview: labelPeriodEndPreview(preview, await getLocale()),
        history,
      });
    } catch (error) {
      return refusal(error, request);
    }
  },
});

/**
 * Generate the fiscal year's period-end journals, or reverse the live ones
 * while their periods are still open. Both record the actor and the reason;
 * generating again with an unchanged ledger posts nothing.
 */
export const POST = defineRoute({
  permission: "close.run",
  feature: "periodEndJournals",
  body: commandSchema,
  invalidBodyStatus: 422,
  handler: async ({ request, authz, body }) => {
    if (authz.allowedSubsidiaryIds !== null && authz.allowedSubsidiaryIds.size === 0) {
      return NextResponse.json(
        {
          error:
            "no legal entities are in the caller's close scope — ask an administrator with access to the legal entities to run this close action",
        },
        { status: 403 },
      );
    }
    const args = {
      periodId: body.periodId,
      bookId: body.bookId,
      reason: body.reason,
      subsidiaryIds: subsidiaryScope(authz.allowedSubsidiaryIds),
    };
    try {
      const result =
        body.action === "generate"
          ? await generatePeriodEndJournals(authz.user.orgId, authz.user.id, args)
          : await reversePeriodEndJournals(authz.user.orgId, authz.user.id, args);
      return NextResponse.json(result);
    } catch (error) {
      return refusal(error, request);
    }
  },
});
