import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { capitalizeEquipmentUnit } from "../../../../../lib/equipment-capitalization";

export const runtime = "nodejs";

export const POST = defineRoute({
  permission: "assets.manage",
  feature: "equipment",
  params: z.object({ id: z.string() }),
  handler: async ({ authz, params }) => capitalizeEquipmentUnit(authz, params),
});
