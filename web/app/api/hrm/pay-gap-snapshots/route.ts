import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  computeGapSnapshot,
  latestGapSnapshot,
} from "@openbooks/engine/src/hrm/compensation/pay-transparency.ts";
import { compensationErrorResponse } from "../compensation/_lib";
import { generateSnapshotBody } from "../compensation/bodies";
/**
 * Pay-gap snapshots. GET reads the latest frozen snapshot; POST
 * computes one from payroll truth (effective rates through the wage
 * rate service, never bands). Both ride comp.manage — equity figures
 * are HR-only. The client checks res.ok before parsing.
 */
export const GET = defineRoute({
  permission: "hrm.compensation.manage",
  feature: "hrmPayTransparency",
  handler: async ({ authz: gate }) => {
    try {
      const snapshot = await latestGapSnapshot({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
      });
      return NextResponse.json({ snapshot });
    } catch (e) {
      return compensationErrorResponse(e);
    }
  },
});
export const POST = defineRoute({
  permission: "hrm.compensation.manage",
  feature: "hrmPayTransparency",
  body: generateSnapshotBody,
  handler: async ({ request: req, authz: gate, body }) => {
    try {
      const snapshot = await computeGapSnapshot({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        asOf: body.asOf,
        groupA: body.groupA,
        groupB: body.groupB,
      });
      return NextResponse.json({ snapshot }, { status: 201 });
    } catch (e) {
      return compensationErrorResponse(e);
    }
  },
});
