import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { NextResponse } from "next/server";
import { getAbsence } from "@openbooks/engine/src/hrm/attendance.ts";
import { can, guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { isUuid } from "../../../../../lib/list-params";
import { leaveErrorResponse } from "../../leave-requests/_lib";

export const runtime = "nodejs";

/**
 * One recorded or request-written absence day behind the calendar entry.
 * Readers and recorders both open it (the engine re-checks the employment
 * behind the day); the drawer shows the fact with its basis.
 */
export const GET = defineRoute({
  public: "session",
  params: z.object({ id: z.string().min(1) }),
  handler: async ({ request: _req, authz: authz, params: routeParams }) => {
    if (!(await isFeatureEnabled(authz.user.orgId, "hrm"))) {
      return notFound("record");
    }
    const gate = can(authz, "hrm.leave.read") ? authz : await guardPermission("hrm.leave.manage");
    if (gate instanceof NextResponse) return gate;
    const { id } = routeParams;
    if (!isUuid(id))
      return NextResponse.json(
        { error: "absence id must be a uuid" },
        { status: 400 },
      );
    try {
      const absence = await getAbsence({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        absenceId: id,
      });
      return NextResponse.json({ absence });
    } catch (e) {
      return leaveErrorResponse(e);
    }
  },
});
