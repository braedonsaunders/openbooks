import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { updateJobFamily } from "@openbooks/engine/src/hrm/compensation/architecture.ts";

import { isUuid } from "../../../../../lib/list-params";
import { compensationErrorResponse } from "../../compensation/_lib";
import { updateFamilyBody } from "../../compensation/bodies";

export const runtime = "nodejs";

/**
 * One job family: PATCH renames, retires or revives it through the
 * manage gate. Families with levels are never deleted (RESTRICT) —
 * retire them instead. The client checks res.ok before parsing.
 */
export const PATCH = defineRoute({
  permission: "hrm.compensation.manage",
  feature: "hrmCompensation",
  params: z.object({ id: z.string().min(1) }),
  body: updateFamilyBody,
  handler: async ({
    request: req,
    authz: gate,
    params: routeParams,
    body: body,
  }) => {
    const { id } = routeParams;
    if (!isUuid(id))
      return NextResponse.json(
        { error: "invalid job family" },
        { status: 400 },
      );

    try {
      const family = await updateJobFamily({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        familyId: id,
        name: body.name ?? null,
        description: body.description ?? null,
        isActive: body.isActive ?? null,
        reason: body.reason,
      });
      return NextResponse.json({ family });
    } catch (e) {
      return compensationErrorResponse(e);
    }
  },
});
