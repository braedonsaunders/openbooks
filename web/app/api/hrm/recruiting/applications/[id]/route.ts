import { z } from "zod";
import { defineRoute } from "@/lib/api/route";

import { NextResponse } from "next/server";
import {
  moveApplicationStage,
  rejectApplication,
  withdrawApplication,
} from "@openbooks/engine/src/hrm/recruiting/applications.ts";

import { isUuid } from "../../../../../../lib/list-params";
import { recruitingErrorResponse } from "../../_lib";
import { patchApplicationBody } from "../bodies";

export const runtime = "nodejs";

/**
 * One application: PATCH moves the candidacy within its own funnel,
 * rejects with a reason, or withdraws — through an action-discriminated
 * body. The route gates on the read grant; beneath it the service admits
 * the hiring manager to MOVES on their own funnel without the manage
 * grant, while reject and withdraw need the grant in full. Every
 * transition appends its evidence in the same transaction.
 */
export const PATCH = defineRoute({
  permission: "hrm.recruiting.read",
  feature: "hrmRecruiting",
  params: z.object({ id: z.string().min(1) }),
  body: patchApplicationBody,
  handler: async ({
    authz: gate,
    params: routeParams,
    body: body,
  }) => {
    const { id } = routeParams;
    if (!isUuid(id))
      return NextResponse.json(
        { error: "invalid application" },
        { status: 400 },
      );

    try {
      if (body.action === "move") {
        const application = await moveApplicationStage({
          orgId: gate.user.orgId,
          actorId: gate.user.id,
          applicationId: id,
          toStageId: body.toStageId,
          reason: body.reason,
        });
        return NextResponse.json({ application });
      }
      if (body.action === "reject") {
        const application = await rejectApplication({
          orgId: gate.user.orgId,
          actorId: gate.user.id,
          applicationId: id,
          reason: body.reason,
        });
        return NextResponse.json({ application });
      }
      const application = await withdrawApplication({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        applicationId: id,
      });
      return NextResponse.json({ application });
    } catch (e) {
      return recruitingErrorResponse(e);
    }
  },
});
