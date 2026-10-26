import { z } from "zod";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import {
  postUnpostedLaborCost,
  previewUnpostedLaborCost,
} from "@openbooks/engine/projects/labor-costing";
import { can } from "@/lib/authz";

export const dynamic = "force-dynamic";

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

const postBody = z.object({
  through: z.string().regex(CALENDAR_DATE, "through must be YYYY-MM-DD"),
  reason: z.string().trim().min(5, "reason must be at least 5 characters").max(500),
});

/**
 * Labor cost catch-up for approved time that was never costed.
 *
 *  GET  ?through=YYYY-MM-DD  preview: per-month entries, hours and standard cost
 *                            per currency, each month's period state, and the
 *                            blockers that refuse posting. Read-only.
 *  POST { through, reason }  cost the eligible rows in open periods. Refused
 *                            with a remedy when labor posting is off, the
 *                            control accounts are unmapped, or Projects is off.
 *
 * Posting writes journals, so it requires gl.post as well as the setup
 * permission (the same boundary as payroll variance posting). Both verbs
 * require unrestricted subsidiary scope because the run spans every entity.
 */
export const GET = defineRoute({
  permission: "admin.setup.manage",
  feature: {
    none: "The preview reports a disabled Projects feature as a blocker instead of hiding the surface.",
  },
  scope: "unrestricted",
  handler: async ({ request, authz }) => {
    const orgId = authz.user.orgId;
    const requested = new URL(request.url).searchParams.get("through");
    const through = requested ?? (await businessToday(orgId));
    if (!CALENDAR_DATE.test(through)) {
      return NextResponse.json({ error: "through must be YYYY-MM-DD" }, { status: 422 });
    }
    try {
      return NextResponse.json(await previewUnpostedLaborCost(orgId, { through }));
    } catch (error) {
      return apiErrorResponse(error, { request });
    }
  },
});

export const POST = defineRoute({
  permission: "admin.setup.manage",
  feature: { none: "Posting reports a disabled Projects feature as a refusal with its remedy." },
  scope: "unrestricted",
  body: postBody,
  invalidBodyStatus: 422,
  handler: async ({ request, body, authz }) => {
    if (!can(authz, "gl.post")) {
      return NextResponse.json({ error: "missing permission: gl.post" }, { status: 403 });
    }
    try {
      const result = await postUnpostedLaborCost(authz.user.orgId, authz.user.id, body);
      return NextResponse.json({ ok: true, ...result });
    } catch (error) {
      return apiErrorResponse(error, { request });
    }
  },
});
