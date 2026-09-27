import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  createJobLevel,
  listJobLevels,
} from "@openbooks/engine/src/hrm/compensation/architecture.ts";
import { isUuid } from "../../../../lib/list-params";
import { compensationErrorResponse } from "../compensation/_lib";
import { createLevelBody } from "../compensation/bodies";
/**
 * Job levels. GET lists (optionally per family) through the read gate;
 * POST authors through the manage gate. A level never moves ladders —
 * retire and recreate instead. The client checks res.ok before parsing.
 */
export const GET = defineRoute({
  permission: "hrm.compensation.read",
  feature: "hrmCompensation",
  handler: async ({ request: req, authz: gate }) => {
    const url = new URL(req.url);
    const familyId = url.searchParams.get("familyId");
    if (familyId !== null && familyId !== "" && !isUuid(familyId)) {
      return NextResponse.json(
        { error: "familyId must be a uuid" },
        { status: 400 },
      );
    }
    const includeInactive = url.searchParams.get("includeInactive") === "1";
    try {
      const levels = await listJobLevels({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        ...(familyId ? { familyId } : {}),
        includeInactive,
      });
      return NextResponse.json({ levels });
    } catch (e) {
      return compensationErrorResponse(e);
    }
  },
});
export const POST = defineRoute({
  permission: "hrm.compensation.manage",
  feature: "hrmCompensation",
  body: createLevelBody,
  handler: async ({ request: req, authz: gate, body }) => {
    try {
      const level = await createJobLevel({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        familyId: body.familyId ?? null,
        code: body.code,
        name: body.name,
        rank: body.rank,
        equalValueCriteria: body.equalValueCriteria,
      });
      return NextResponse.json({ level }, { status: 201 });
    } catch (e) {
      return compensationErrorResponse(e);
    }
  },
});
