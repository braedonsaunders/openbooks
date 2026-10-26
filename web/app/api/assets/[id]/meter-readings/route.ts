import { z } from "zod";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { recordUsageReading } from "@openbooks/engine/assets/asset-maintenance";
import { calendarDate, id, money, optionalText, scopeOf } from "../../_depth";

export const runtime = "nodejs";

/** Record a meter reading (hours, kilometres, cycles); readings never run backwards. */
export const POST = defineRoute({
  permission: "assets.maintain",
  feature: "assetMaintenance",
  params: z.object({ id }),
  body: z.strictObject({
    readOn: calendarDate("readOn"),
    reading: money("reading"),
    unit: z.string().trim().min(1, "name the meter unit").max(40),
    memo: optionalText(500),
  }),
  invalidBodyStatus: 422,
  handler: async ({ authz: gate, params, body: input }) => {
    const { id: assetId } = await params;
    const created = await recordUsageReading(
      gate.user.orgId,
      { assetId, ...input, memo: input.memo ?? null },
      { actorId: gate.user.id, allowedSubsidiaryIds: scopeOf(gate) },
    );
    return NextResponse.json(created, { status: 201 });
  },
});
