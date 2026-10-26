import { z } from "zod";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { createMaintenanceSchedule } from "@openbooks/engine/assets/asset-maintenance";
import { id, scopeOf } from "../../_depth";
import { scheduleFields } from "../_fields";

export const runtime = "nodejs";

/** Create a maintenance schedule for an asset (time and/or usage interval). */
export const POST = defineRoute({
  permission: "assets.maintain",
  feature: "assetMaintenance",
  body: z.strictObject({ assetId: id, ...scheduleFields }),
  invalidBodyStatus: 422,
  handler: async ({ authz: gate, body: input }) => {
    const created = await createMaintenanceSchedule(gate.user.orgId, input, {
      actorId: gate.user.id,
      allowedSubsidiaryIds: scopeOf(gate),
    });
    return NextResponse.json(created, { status: 201 });
  },
});
