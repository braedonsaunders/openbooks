import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { getAbsence } from "@openbooks/engine/hrm/attendance";
import { guardPermission } from "@/lib/authz";
import { isUuid } from "@/lib/list-params";
import { leaveErrorResponse } from "../../leave-requests/_lib";

export const runtime = "nodejs";

/**
 * One recorded or request-written absence day behind the calendar entry.
 * Readers and recorders both open it (the engine re-checks the employment
 * behind the day); the drawer shows the fact with its basis.
 */
export const GET = defineRoute({
  authorize: async () => {
    const read = await guardPermission("hrm.leave.read");
    return read instanceof NextResponse && read.status === 403
      ? await guardPermission("hrm.leave.manage")
      : read;
  },
  feature: "hrm",
  params: z.object({ id: z.string().min(1) }),
  handler: async ({ params: routeParams, authz: gate }) => {
    const { id } = routeParams;
    if (!isUuid(id))
      return NextResponse.json({ error: "absence id must be a uuid" }, { status: 400 });
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
