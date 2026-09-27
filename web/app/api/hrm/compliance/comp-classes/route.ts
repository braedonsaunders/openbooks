import { defineRoute } from "@/lib/api/route";
import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/src/platform/db.ts";
import {
  classify,
  createCompClass,
  createCompRule,
  dailySplit,
  listCompClasses,
} from "@openbooks/engine/src/hrm/construction/comp-classes.ts";
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
  handler: async ({ request: req, authz: gate }) => {
    const url = new URL(req.url);
    const action = url.searchParams.get("action");
    if (action === "rule") {
      const parsedBody = await parseJsonBody(req, createCompRuleBody);
      if (!parsedBody.ok) return parsedBody.response;
      try {
        const rule = await createCompRule(db, {
          orgId: gate.user.orgId,
          actorId: gate.user.id,
          priority: parsedBody.data.priority,
          match: parsedBody.data.match as never,
          compClassId: parsedBody.data.compClassId,
        });
        return NextResponse.json({ rule }, { status: 201 });
      } catch (e) {
        return constructionErrorResponse(e);
      }
    }
    if (action === "split" || action === "classify") {
      const parsedBody = await parseJsonBody(req, splitBody);
      if (!parsedBody.ok) return parsedBody.response;
      try {
        if (action === "classify") {
          const compClass = await classify(db, {
            orgId: gate.user.orgId,
            actorId: gate.user.id,
            projectId: parsedBody.data.projectId,
            workedOn: parsedBody.data.workedOn,
          });
          return NextResponse.json({ compClass });
        }
        const split = await dailySplit(db, {
          orgId: gate.user.orgId,
          actorId: gate.user.id,
          projectId: parsedBody.data.projectId,
          workedOn: parsedBody.data.workedOn,
        });
        return NextResponse.json({ split });
      } catch (e) {
        return constructionErrorResponse(e);
      }
    }
    const parsedBody = await parseJsonBody(req, createCompClassBody);
    if (!parsedBody.ok) return parsedBody.response;
    try {
      const compClass = await createCompClass(db, {
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        ...parsedBody.data,
      });
      return NextResponse.json({ compClass }, { status: 201 });
    } catch (e) {
      return constructionErrorResponse(e);
    }
  },
});
