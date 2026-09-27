import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { updateJobLevel } from "@openbooks/engine/src/hrm/compensation/architecture.ts";
import { isUuid } from "../../../../../lib/list-params";
import { compensationErrorResponse } from "../../compensation/_lib";
import { updateLevelBody } from "../../compensation/bodies";
/**
 * One job level: PATCH renames, re-ranks, re-declares criteria, retires
 * or revives it through the manage gate. The ladder never moves — retire
 * and recreate on the right one. The client checks res.ok before parsing.
 */
export const PATCH = defineRoute({
  permission: "hrm.compensation.manage",
  feature: "hrmCompensation",
  body: updateLevelBody,
  params: z.object({ id: z.string() }),
  handler: async ({ request: _req, authz: gate, params, body }) => {
    const { id } = params;
    if (!isUuid(id))
      return NextResponse.json({ error: "invalid job level" }, { status: 400 });
    try {
      const level = await updateJobLevel({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        levelId: id,
        name: body.name ?? null,
        rank: body.rank ?? null,
        equalValueCriteria:
          body.equalValueCriteria === undefined
            ? undefined
            : (body.equalValueCriteria ?? null),
        isActive: body.isActive ?? null,
        reason: body.reason,
      });
      return NextResponse.json({ level });
    } catch (e) {
      return compensationErrorResponse(e);
    }
  },
});
