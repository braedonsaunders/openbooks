import { z } from "zod";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { applicationContextFromSession } from "@/lib/application/context";
import { readApplicationPeriodLocks } from "@/lib/application/close";

export const runtime = "nodejs";

/** Required exact scope, canonicalized once so scope checks compare like case. */
const locksQuerySchema = z.object({
  periodId: z.string().uuid().transform((value) => value.toLowerCase()),
  bookId: z.string().uuid().transform((value) => value.toLowerCase()),
  subsidiaryId: z.string().uuid().transform((value) => value.toLowerCase()),
});

/**
 * GET /api/close/locks?periodId&bookId&subsidiaryId — the effective period
 * lock for every close module (GL included) at exactly that period, book and
 * legal entity: the entity row where one governs, otherwise the
 * organization-wide fallback, otherwise an explicitly derived open state
 * with no stored provenance. Snapshot information only; posting rechecks
 * the same resolution atomically.
 */
export const GET = defineRoute({
  permission: "close.read",
  feature: { none: "Inspecting period posting locks is a core accounting control." },
  handler: async ({ request, authz }) => {
    const search = new URL(request.url).searchParams;
    const query = locksQuerySchema.safeParse({
      periodId: search.get("periodId"),
      bookId: search.get("bookId"),
      subsidiaryId: search.get("subsidiaryId"),
    });
    if (!query.success) {
      return NextResponse.json(
        { error: "periodId, bookId and subsidiaryId must each name a valid UUID" },
        { status: 400 },
      );
    }
    const context = applicationContextFromSession(
      authz,
      "api",
      request.headers.get("x-request-id") ?? "",
    );
    const locks = await readApplicationPeriodLocks(context, query.data);
    return NextResponse.json({ locks });
  },
});
