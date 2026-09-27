import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  deactivateDependent,
  updateDependent,
} from "@openbooks/engine/src/hrm/benefits/dependents.ts";
import { isUuid } from "../../../../../lib/list-params";
import { benefitsErrorResponse } from "../../benefits/_lib";
import { updateDependentBody } from "../bodies";
/** Edit a dependent's descriptors, or retire them. Identity never moves. */
export const PATCH = defineRoute({
  permission: "hrm.benefits.manage",
  feature: "hrm",
  body: updateDependentBody,
  params: z.object({ id: z.string() }),
  handler: async ({ request: req, authz: gate, params, body }) => {
    const { id } = params;
    if (!isUuid(id))
      return NextResponse.json(
        { error: "dependent id must be a uuid" },
        { status: 400 },
      );
    const base = {
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      dependentId: id,
    };
    try {
      if (body.action === "deactivate") {
        const dependent = await deactivateDependent(base);
        return NextResponse.json({ dependent });
      }
      const dependent = await updateDependent({
        ...base,
        ...(body.relationship !== undefined
          ? { relationship: body.relationship }
          : {}),
        ...(body.displayName !== undefined
          ? { displayName: body.displayName }
          : {}),
        birthDate: body.birthDate ?? undefined,
      });
      return NextResponse.json({ dependent });
    } catch (e) {
      return benefitsErrorResponse(e);
    }
  },
});
