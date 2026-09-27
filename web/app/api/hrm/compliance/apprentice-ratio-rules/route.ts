import { defineRoute } from "@/lib/api/route";
import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/src/platform/db.ts";
import {
  checkDay,
  createRatioRule,
} from "@openbooks/engine/src/hrm/construction/ratios.ts";
import { constructionErrorResponse } from "../_lib";
import { checkDayBody, createRatioRuleBody } from "../bodies";
/** Apprentice ratio rules and day checks. */
export const POST = defineRoute({
  permission: "hrm.construction.manage",
  feature: "hrmConstructionCompliance",
  handler: async ({ request: req, authz: gate }) => {
    const url = new URL(req.url);
    if (url.searchParams.get("check") === "1") {
      const parsedBody = await parseJsonBody(req, checkDayBody);
      if (!parsedBody.ok) return parsedBody.response;
      try {
        const results = await checkDay(db, {
          orgId: gate.user.orgId,
          actorId: gate.user.id,
          ...parsedBody.data,
        });
        return NextResponse.json({ results });
      } catch (e) {
        return constructionErrorResponse(e);
      }
    }
    const parsedBody = await parseJsonBody(req, createRatioRuleBody);
    if (!parsedBody.ok) return parsedBody.response;
    try {
      const rule = await createRatioRule(db, {
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        ...parsedBody.data,
      });
      return NextResponse.json({ rule }, { status: 201 });
    } catch (e) {
      return constructionErrorResponse(e);
    }
  },
});
