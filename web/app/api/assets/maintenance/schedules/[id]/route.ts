import { z } from "zod";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { updateMaintenanceSchedule } from "@openbooks/engine/assets/asset-maintenance";
import { id, scopeOf } from "../../../_depth";
import { scheduleFields } from "../../_fields";

export const runtime = "nodejs";

/** Change a schedule's terms or switch it off; its next due point is recomputed. */
export const PATCH = defineRoute({
  permission: "assets.maintain",
  feature: "assetMaintenance",
  params: z.object({ id }),
  body: z.strictObject({ ...scheduleFields, isActive: z.boolean() }),
  invalidBodyStatus: 422,
  handler: async ({ authz: gate, params, body: input }) => {
    const { id: scheduleId } = await params;
    return NextResponse.json(
      await updateMaintenanceSchedule(gate.user.orgId, scheduleId, input, {
        actorId: gate.user.id,
        allowedSubsidiaryIds: scopeOf(gate),
      }),
    );
  },
});
