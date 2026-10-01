import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { previewIncentiveSettlement } from "@openbooks/engine/hrm/benefits";
import { isUuid } from "@/lib/list-params";
import { benefitsErrorResponse } from "@/app/api/hrm/benefits/_lib";

/**
 * Simulate a settlement period: the same measure and math settlement runs,
 * over an explicit period that may be historical (posted and approved
 * sources only — real data, never a projection). Writes nothing; a preview
 * is never an obligation. Future spans are labeled estimates.
 */
export const runtime = "nodejs";

export const GET = defineRoute({
  permission: "hrm.benefits.read",
  feature: "hrm",
  params: z.object({ id: z.string().min(1) }),
  handler: async ({ authz: gate, params: routeParams, request: req }) => {
    const { id } = routeParams;
    if (!isUuid(id)) return NextResponse.json({ error: "program id must be a uuid" }, { status: 400 });
    const url = new URL(req.url);
    const periodFrom = url.searchParams.get("periodFrom") ?? "";
    const periodTo = url.searchParams.get("periodTo") ?? "";
    if (!periodFrom || !periodTo) {
      return NextResponse.json(
        { error: "preview names its period: periodFrom and periodTo as YYYY-MM-DD" },
        { status: 400 },
      );
    }
    try {
      const preview = await previewIncentiveSettlement({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        programId: id,
        periodFrom,
        periodTo,
      });
      return NextResponse.json({ preview });
    } catch (e) {
      return benefitsErrorResponse(e);
    }
  },
});
