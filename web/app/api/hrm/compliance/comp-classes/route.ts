import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@openbooks/engine/platform/db";
import {
  classify,
  createCompClass,
  createCompRule,
  dailySplit,
  listCompClasses,
} from "@openbooks/engine/hrm/construction/comp-classes";
import { constructionErrorResponse } from "../_lib";
import { createCompClassBody, createCompRuleBody, splitBody } from "../bodies";
/** Comp classes, their priority match rules, and the daily split report. */
export const GET = defineRoute({
  permission: "hrm.construction.read",
  feature: "hrmConstructionCompliance",
  handler: async ({ authz: gate }) => {
    try {
      const classes = await listCompClasses(db, gate.user.orgId, gate.user.id);
      return NextResponse.json({ classes });
    } catch (e) {
      return constructionErrorResponse(e);
    }
  },
});
export const POST = defineRoute({
  permission: "hrm.construction.manage",
  feature: "hrmConstructionCompliance",
  body: ({ request }) => {
    const action = new URL(request.url).searchParams.get("action");
    return action === "rule"
      ? createCompRuleBody
      : action === "split" || action === "classify"
        ? splitBody
        : createCompClassBody;
  },
  handler: async ({ request: req, authz: gate, body }) => {
    const url = new URL(req.url);
    const action = url.searchParams.get("action");
    if (action === "rule") {
      const parsedBody = body as z.output<typeof createCompRuleBody>;
      try {
        const rule = await createCompRule(db, {
          orgId: gate.user.orgId,
          actorId: gate.user.id,
          priority: parsedBody.priority,
          match: parsedBody.match as never,
          compClassId: parsedBody.compClassId,
        });
        return NextResponse.json({ rule }, { status: 201 });
      } catch (e) {
        return constructionErrorResponse(e);
      }
    }
    if (action === "split" || action === "classify") {
      const parsedBody = body as z.output<typeof splitBody>;
      try {
        if (action === "classify") {
          const compClass = await classify(db, {
            orgId: gate.user.orgId,
            actorId: gate.user.id,
            projectId: parsedBody.projectId,
            workedOn: parsedBody.workedOn,
          });
          return NextResponse.json({ compClass });
        }
        const split = await dailySplit(db, {
          orgId: gate.user.orgId,
          actorId: gate.user.id,
          projectId: parsedBody.projectId,
          workedOn: parsedBody.workedOn,
        });
        return NextResponse.json({ split });
      } catch (e) {
        return constructionErrorResponse(e);
      }
    }
    const parsedBody = body as z.output<typeof createCompClassBody>;
    try {
      const compClass = await createCompClass(db, {
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        ...parsedBody,
      });
      return NextResponse.json({ compClass }, { status: 201 });
    } catch (e) {
      return constructionErrorResponse(e);
    }
  },
});
