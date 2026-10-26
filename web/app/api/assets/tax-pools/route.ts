import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/platform/db";
import {
  findActiveTaxPoolBook,
  findTaxPoolSubsidiary,
  listTaxPoolRouteRows,
} from "@openbooks/engine/assets/tax-pool-route-queries";
import { activePostingPrimaryBookId } from "@openbooks/engine/platform/database";
import { listTaxRegimes, runTaxPool } from "@openbooks/engine/tax-returns/pool-run";
import { isIsoCalendarDate } from "@openbooks/engine/platform/business-date/module";
import {
  SubsidiaryError,
  defaultPostingSubsidiaryId,
  loadSubsidiaryContext,
} from "@openbooks/engine/organization/subsidiaries";
import { guardSubsidiaryScope } from "@/lib/authz";
import { isUuid } from "@/lib/list-params";
import { isoDate } from "@/lib/api/json";
import { notFound } from "@/lib/api/responses";
const postBodySchema0 = z.strictObject({
  regime: z.string().trim().min(1, "regime cannot be empty").optional(),
  taxYear: z.number().int().min(1000).max(9999),
  yearStart: isoDate("yearStart must be a valid calendar date").optional(),
  yearEnd: isoDate("yearEnd must be a valid calendar date").optional(),
  bookId: uuidString("bookId must be a valid id").optional(),
  // A supplied subsidiary remains an ownership lookup: malformed and hidden
  // identifiers share the same not-found response in the handler.
  subsidiaryId: z.string().optional(),
});

export const runtime = "nodejs";

/** A year the run window can be built from: the Jan-1 fallback must be a real calendar day. */
function isRunnableTaxYear(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && isIsoCalendarDate(`${value}-01-01`)
  );
}

/**
 * The shared unscoped-posting default: the hierarchy root. An org with no
 * subsidiaries at all keeps the established 422 instead of a 500.
 */
async function rootSubsidiary(orgId: string): Promise<string | null> {
  try {
    return defaultPostingSubsidiaryId(await loadSubsidiaryContext(db, orgId));
  } catch (e) {
    if (!(e instanceof SubsidiaryError)) throw e;
    return null;
  }
}

/** Read a tax year's computed pool results (Schedule 8-style). */
export const GET = defineRoute({
  permission: "assets.read",
  feature: "fixedAssets",
  handler: async ({ request: req, authz: gate }) => {
    const p = new URL(req.url).searchParams;
    const taxYear = Number(p.get("taxYear"));
    if (!Number.isInteger(taxYear))
      return NextResponse.json({ error: "taxYear required" }, { status: 422 });
    const r = await listTaxPoolRouteRows({
      orgId: gate.user.orgId,
      taxYear,
      allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
    });
    return NextResponse.json({ rows: r });
  },
});

/** Run the tax pools for a year (defaults: primary book, root subsidiary, calendar year). */
export const POST = defineRoute({
  permission: "assets.manage",
  feature: "fixedAssets",
  body: postBodySchema0,
  invalidBodyStatus: 422,
  handler: async ({ request: _req, authz: gate, body: routeBody }) => {
    const body = routeBody;
    const availableRegimes = await listTaxRegimes(gate.user.orgId);
    const regime = body.regime || availableRegimes[0]?.code;
    if (!regime || !availableRegimes.some((item) => item.code === regime)) {
      return NextResponse.json(
        {
          error: "tax depreciation regime is not enabled for this company country",
        },
        { status: 422 },
      );
    }
    // The window ends land in date comparisons inside the run: a shape-valid
    // non-day would die there with a raw failure the catch can only surface as
    // driver text. Refuse anything that is not a real calendar day up front.
    if (!isRunnableTaxYear(body.taxYear))
      return NextResponse.json(
        { error: "taxYear must be a runnable calendar year" },
        { status: 422 },
      );
    const taxYear = body.taxYear;
    // An omitted end keeps the year boundary; a supplied end that is not a
    // real calendar day is refused — it must never silently become Jan 1.
    for (const [label, value] of [
      ["Year start", body.yearStart],
      ["Year end", body.yearEnd],
    ] as const) {
      if (value !== undefined && value !== null && value !== "" && !isIsoCalendarDate(value)) {
        return NextResponse.json(
          { error: `${label} must be a real calendar date (YYYY-MM-DD)` },
          { status: 422 },
        );
      }
    }
    const yearStart = isIsoCalendarDate(body.yearStart) ? body.yearStart : `${taxYear}-01-01`;
    const yearEnd = isIsoCalendarDate(body.yearEnd) ? body.yearEnd : `${taxYear}-12-31`;
    if (yearStart > yearEnd)
      return NextResponse.json({ error: "year start must not follow year end" }, { status: 422 });
    if (yearStart !== `${taxYear}-01-01` || yearEnd !== `${taxYear}-12-31`) {
      return NextResponse.json(
        {
          error:
            "short tax-year windows are not supported; run the full calendar tax year because no regime-specific short-year factor is configured",
        },
        { status: 422 },
      );
    }

    let bookId: string | null;
    if (body.bookId !== undefined) {
      if (typeof body.bookId !== "string" || !isUuid(body.bookId)) {
        return NextResponse.json({ error: "invalid bookId" }, { status: 422 });
      }
      const book = await findActiveTaxPoolBook(gate.user.orgId, body.bookId);
      if (!book) return notFound("record");
      bookId = book.id;
    } else {
      bookId = await activePostingPrimaryBookId(gate.user.orgId);
    }

    // An explicit subsidiary is a write target, not merely a run parameter.
    // Resolve it inside this org before applying the caller's subsidiary scope;
    // otherwise an unrestricted caller could even pass a foreign-org UUID into
    // the engine, while a restricted caller could mutate an entity they cannot
    // see. Omitting the field keeps the established root-subsidiary default, but
    // that root is still subject to the same scope gate.
    const requestedSubsidiaryId =
      typeof body.subsidiaryId === "string" && body.subsidiaryId.trim()
        ? body.subsidiaryId
        : undefined;
    let subsidiaryId: string | null;
    if (requestedSubsidiaryId) {
      // A malformed id names nothing: same answer as a subsidiary in another
      // org, and answered before the id reaches SQL (a raw uuid comparison
      // throws 22P02 out of the handler as a 500).
      if (!isUuid(requestedSubsidiaryId)) return notFound("record");
      const requestedDenied = guardSubsidiaryScope(gate, requestedSubsidiaryId);
      if (requestedDenied) return requestedDenied;
      const subsidiary = await findTaxPoolSubsidiary(gate.user.orgId, requestedSubsidiaryId);
      if (!subsidiary) return notFound("record");
      subsidiaryId = subsidiary.id;
    } else {
      subsidiaryId = await rootSubsidiary(gate.user.orgId);
    }

    if (!bookId || !subsidiaryId)
      return NextResponse.json(
        { error: "no accounting book / subsidiary configured" },
        { status: 422 },
      );
    const denied = guardSubsidiaryScope(gate, subsidiaryId);
    if (denied) return denied;

    try {
      const result = await runTaxPool(gate.user.orgId, bookId, subsidiaryId, regime, taxYear, {
        yearStart,
        yearEnd,
        actorId: gate.user.id,
      });
      return NextResponse.json(result);
    } catch (e: unknown) {
      return apiErrorResponse(e, { safeStatus: 422 });
    }
  },
});
