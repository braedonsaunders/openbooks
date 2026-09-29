import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { createEnrollmentWindow } from "@openbooks/engine/src/hrm/benefits/windows.ts";
import { listEnrollmentWindows } from "@openbooks/engine/src/hrm/benefits/benefits-read.ts";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { benefitsErrorResponse } from "../benefits/_lib";
import { createWindowBody } from "./bodies";
/**
 * Enrollment windows: GET lists (optionally segmented by status through
 * the shared filter-chips value), POST creates a draft. Opening and
 * closing ride [id]/open and [id]/close.
 */
export const GET = defineRoute({
  permission: "hrm.benefits.read",
  feature: "hrm",
  handler: async ({ request: req, authz: gate }) => {
    const url = new URL(req.url);
    const status = url.searchParams.get("status");
    if (
      status !== null &&
      status !== "draft" &&
      status !== "open" &&
      status !== "closed"
    ) {
      return NextResponse.json({ error: "unknown status" }, { status: 400 });
    }
    try {
      const windows = await listEnrollmentWindows(
        db,
        gate.user.orgId,
        gate.user.id,
        {
          ...(status ? { status } : {}),
        },
      );
      return NextResponse.json({ windows });
    } catch (e) {
      return benefitsErrorResponse(e);
    }
  },
});
export const POST = defineRoute({
  permission: "hrm.benefits.manage",
  feature: "hrm",
  body: createWindowBody,
  invalidBodyStatus: 400,
  handler: async ({ request: _req, authz: gate, body }) => {
    try {
      const window = await createEnrollmentWindow({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        name: body.name,
        kind: body.kind,
        opensOn: body.opensOn,
        closesOn: body.closesOn,
        planYearStartOn: body.planYearStartOn,
        employerSubsidiaryId: body.employerSubsidiaryId ?? null,
        departmentId: body.departmentId ?? null,
      });
      return NextResponse.json({ window });
    } catch (e) {
      return benefitsErrorResponse(e);
    }
  },
});
