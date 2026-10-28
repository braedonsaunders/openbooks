import { defineRoute } from "@/lib/api/route";
import { createLaborRateCard, createLaborRateCardSchema } from "@/lib/labor-rate-card-actions";

export const POST = defineRoute({
  permission: "admin.setup.manage",
  feature: "projects",
  body: createLaborRateCardSchema,
  handler: async ({ body, authz }) => createLaborRateCard(authz, body),
});
