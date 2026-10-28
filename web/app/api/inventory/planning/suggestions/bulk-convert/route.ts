import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { Body, bulkConvertPlanSuggestions } from "@/lib/inventory-planning-bulk-conversion";

const Params = z.object({}).strict();

export const POST = defineRoute({
  permission: "inventory.plan",
  feature: "demandPlanning",
  params: Params,
  body: Body,
  handler: async ({ authz, body }) => bulkConvertPlanSuggestions(authz, body),
});
