import { z } from "zod";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import {
  cancelMaintenanceRecord,
  recordMaintenance,
} from "@openbooks/engine/assets/asset-maintenance";
import { calendarDate, id, optionalMoney, reasonText, scopeOf } from "../../_depth";

export const runtime = "nodejs";

const body = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("record"),
    assetId: id,
    scheduleId: id.nullable().optional(),
    performedOn: calendarDate("performedOn"),
    usageReading: optionalMoney("usageReading"),
    description: z.string().trim().min(1, "describe the work performed").max(2000),
    vendorPartyId: id.nullable().optional(),
    cost: optionalMoney("cost"),
    treatment: z.enum(["expense", "betterment"]),
    sourceDocumentLineId: id.nullable().optional(),
  }),
  z.strictObject({ action: z.literal("cancel"), recordId: id, reason: reasonText }),
]);

/**
 * Record maintenance work (linked to the bill line that paid for it; a
 * betterment is proposed for capitalization), or cancel a record entered in
 * error.
 */
export const POST = defineRoute({
  permission: "assets.maintain",
  feature: "assetMaintenance",
  body,
  invalidBodyStatus: 422,
  handler: async ({ authz: gate, body: input }) => {
    if (input.action === "cancel") {
      await cancelMaintenanceRecord(gate.user.orgId, {
        recordId: input.recordId,
        reason: input.reason,
        actorId: gate.user.id,
        allowedSubsidiaryIds: scopeOf(gate),
      });
      return NextResponse.json({ ok: true });
    }
    const { action: _action, ...record } = input;
    const created = await recordMaintenance(gate.user.orgId, record, {
      actorId: gate.user.id,
      allowedSubsidiaryIds: scopeOf(gate),
    });
    return NextResponse.json(created, { status: 201 });
  },
});
