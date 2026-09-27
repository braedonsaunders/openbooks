import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  createSuccessionPlan,
  listSuccessionPlans,
  setSuccessionPlanNotes,
  setSuccessionPlanStatus,
} from "@openbooks/engine/src/hrm/performance/talent.ts";
import { performanceErrorResponse } from "../review-cycles/_lib";
import { createSuccessionPlanBody, patchSuccessionPlanBody } from "./bodies";
/**
 * Succession plans with ranked candidates. GET lists HR-only plans;
 * POST creates one per position; PATCH moves draft/active/archived.
 * There is no candidate self view. The client checks res.ok before
 * parsing.
 */
export const GET = defineRoute({
  permission: "hrm.performance.manage",
  feature: "hrmSuccession",
  handler: async ({ request: req, authz }) => {
    void req;
    try {
      const plans = await listSuccessionPlans({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
      });
      return NextResponse.json({ plans });
    } catch (e) {
      return performanceErrorResponse(e);
    }
  },
});
export const POST = defineRoute({
  permission: "hrm.performance.manage",
  feature: "hrmSuccession",
  body: createSuccessionPlanBody,
  handler: async ({ request: req, authz, body }) => {
    try {
      const plan = await createSuccessionPlan({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        positionId: body.positionId,
        incumbentEmploymentId: body.incumbentEmploymentId ?? null,
        notes: body.notes ?? null,
      });
      return NextResponse.json({ plan }, { status: 201 });
    } catch (e) {
      return performanceErrorResponse(e);
    }
  },
});
export const PATCH = defineRoute({
  permission: "hrm.performance.manage",
  feature: "hrmSuccession",
  body: patchSuccessionPlanBody,
  handler: async ({ request: req, authz, body }) => {
    const id = new URL(req.url).searchParams.get("id");
    if (!id)
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    try {
      if (body.status !== undefined) {
        await setSuccessionPlanStatus({
          orgId: authz.user.orgId,
          actorId: authz.user.id,
          id,
          status: body.status,
        });
      }
      if (body.notes !== undefined) {
        await setSuccessionPlanNotes({
          orgId: authz.user.orgId,
          actorId: authz.user.id,
          id,
          notes: body.notes,
        });
      }
      return NextResponse.json({ ok: true });
    } catch (e) {
      return performanceErrorResponse(e);
    }
  },
});
