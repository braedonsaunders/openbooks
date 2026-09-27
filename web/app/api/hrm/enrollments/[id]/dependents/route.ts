import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  linkDependent,
  unlinkDependent,
} from "@openbooks/engine/src/hrm/benefits/dependents.ts";

import { isUuid } from "../../../../../../lib/list-params";
import { benefitsErrorResponse } from "../../../benefits/_lib";
import { linkDependentBody } from "../../bodies";

export const runtime = "nodejs";

/**
 * Cover or uncover a dependent on one election. The engine proves both
 * rows belong to the same employment — a cross-employment link is refused.
 */
export const POST = defineRoute({
  permission: "hrm.benefits.manage",
  feature: "hrm",
  params: z.object({ id: z.string().min(1) }),
  body: linkDependentBody,
  handler: async ({
    request: req,
    authz: gate,
    params: routeParams,
    body: body,
  }) => {
    const { id } = routeParams;
    if (!isUuid(id))
      return NextResponse.json(
        { error: "enrollment id must be a uuid" },
        { status: 400 },
      );

    try {
      if (body.action === "link") {
        await linkDependent({
          orgId: gate.user.orgId,
          actorId: gate.user.id,
          enrollmentId: id,
          dependentId: body.dependentId,
        });
      } else {
        await unlinkDependent({
          orgId: gate.user.orgId,
          actorId: gate.user.id,
          enrollmentId: id,
          dependentId: body.dependentId,
        });
      }
      return NextResponse.json({ ok: true });
    } catch (e) {
      return benefitsErrorResponse(e);
    }
  },
});
