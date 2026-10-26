import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@openbooks/engine/platform/db";
import { checkDay, createRatioRule } from "@openbooks/engine/hrm/construction/ratios";
import { constructionErrorResponse } from "../_lib";
import { checkDayBody, createRatioRuleBody } from "../bodies";
/** Apprentice ratio rules and day checks. */
export const POST = defineRoute({
  permission: "hrm.construction.manage",
  feature: "hrmConstructionCompliance",
  body: ({ request }) =>
    new URL(request.url).searchParams.get("check") === "1" ? checkDayBody : createRatioRuleBody,
  handler: async ({ request: req, authz: gate, body }) => {
    const url = new URL(req.url);
    if (url.searchParams.get("check") === "1") {
      const parsedBody = body as z.output<typeof checkDayBody>;
      try {
        const results = await checkDay(db, {
          orgId: gate.user.orgId,
          actorId: gate.user.id,
          ...parsedBody,
        });
        return NextResponse.json({ results });
      } catch (e) {
        return constructionErrorResponse(e);
      }
    }
    const parsedBody = body as z.output<typeof createRatioRuleBody>;
    try {
      const rule = await createRatioRule(db, {
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        ...parsedBody,
      });
      return NextResponse.json({ rule }, { status: 201 });
    } catch (e) {
      return constructionErrorResponse(e);
    }
  },
});
