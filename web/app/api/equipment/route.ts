import { defineRoute } from "@/lib/api/route";
import { createEquipmentSchema, createEquipmentUnit } from "@/lib/equipment-create";

export const runtime = "nodejs";

export const POST = defineRoute({
  permission: "assets.manage",
  feature: "equipment",
  body: createEquipmentSchema,
  handler: async ({ request, authz, body }) =>
    createEquipmentUnit(authz, request.headers.get("Idempotency-Key")?.trim() ?? "", body),
});
