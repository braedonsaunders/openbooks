import { z } from "zod";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { statutoryHolidayCalendarsOf } from "@openbooks/engine/payroll/holidays";
import { businessToday } from "@openbooks/engine/platform/business-date/module";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const querySchema = z.strictObject({
  year: z.coerce.number().int().min(1900).max(2999).optional(),
});

/**
 * GET /api/payroll/statutory-holidays?year=YYYY — the statutory holiday
 * calendars the organization's active payroll profiles run under, for one
 * civil year (default: the current business year). Each calendar carries the
 * days payroll applies, the pack's citation, and any jurisdiction that cannot
 * be read as a refusal. Read-only: the country pack maintains these days.
 */
export const GET = defineRoute({
  permission: "payroll.read",
  feature: "payroll",
  handler: async ({ request, authz }) => {
    const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!query.success) {
      return NextResponse.json({ error: "Choose a year between 1900 and 2999" }, { status: 422 });
    }
    const orgId = authz.user.orgId;
    const year = query.data.year ?? Number((await businessToday(orgId)).slice(0, 4));
    const reading = await statutoryHolidayCalendarsOf({
      orgId,
      year,
      subsidiaryIds: authz.allowedSubsidiaryIds === null ? null : [...authz.allowedSubsidiaryIds],
    });
    return NextResponse.json({ year, ...reading });
  },
});
