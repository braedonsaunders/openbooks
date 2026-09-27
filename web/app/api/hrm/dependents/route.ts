import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { createDependent } from "@openbooks/engine/src/hrm/benefits/dependents.ts";
import { listDependents } from "@openbooks/engine/src/hrm/benefits/benefits-read.ts";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { isUuid } from "../../../../lib/list-params";
import { benefitsErrorResponse } from "../benefits/_lib";
import { createDependentBody } from "./bodies";
/**
 * Covered dependents: GET lists one employment's, POST creates. Reads need
 * hrm.benefits.read on the employment; writes need manage on it.
 */
export const GET = defineRoute({
  permission: "hrm.benefits.read",
  feature: "hrm",
  handler: async ({ request: req, authz: gate }) => {
    const url = new URL(req.url);
    const employmentId = url.searchParams.get("employmentId");
    if (!employmentId || !isUuid(employmentId)) {
      return NextResponse.json(
        { error: "employment id must be a uuid" },
        { status: 400 },
      );
    }
    try {
      const dependents = await listDependents(
        db,
        gate.user.orgId,
        gate.user.id,
        employmentId,
      );
      return NextResponse.json({ dependents });
    } catch (e) {
      return benefitsErrorResponse(e);
    }
  },
});
export const POST = defineRoute({
  permission: "hrm.benefits.manage",
  feature: "hrm",
  body: createDependentBody,
  handler: async ({ request: _req, authz: gate, body }) => {
    try {
      const dependent = await createDependent({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        employmentId: body.employmentId,
        relationship: body.relationship,
        displayName: body.displayName,
        birthDate: body.birthDate ?? null,
      });
      return NextResponse.json({ dependent });
    } catch (e) {
      return benefitsErrorResponse(e);
    }
  },
});
