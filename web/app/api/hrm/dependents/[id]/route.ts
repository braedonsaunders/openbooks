import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import {
  deactivateDependent,
  updateDependent,
} from "@openbooks/engine/src/hrm/benefits/dependents.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { isUuid } from "../../../../../lib/list-params";
import { benefitsErrorResponse } from "../../benefits/_lib";
import { updateDependentBody } from "../bodies";

export const runtime = "nodejs";

/** Edit a dependent's descriptors, or retire them. Identity never moves. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.benefits.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "dependent id must be a uuid" }, { status: 400 });
  const parsedBody = await parseJsonBody(req, updateDependentBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  const base = { orgId: gate.user.orgId, actorId: gate.user.id, dependentId: id };
  try {
    if (body.action === "deactivate") {
      const dependent = await deactivateDependent(base);
      return NextResponse.json({ dependent });
    }
    const dependent = await updateDependent({
      ...base,
      ...(body.relationship !== undefined ? { relationship: body.relationship } : {}),
      ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
      birthDate: body.birthDate ?? undefined,
    });
    return NextResponse.json({ dependent });
  } catch (e) {
    return benefitsErrorResponse(e);
  }
}
