import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { cardBodySchema, updateLaborRateCard } from "@/lib/labor-rate-card-actions";

export const PUT = defineRoute({
  permission: "admin.setup.manage",
  feature: "projects",
  params: z.object({ id: z.string() }),
  body: cardBodySchema,
  handler: async ({ params: { id }, body, authz }) => updateLaborRateCard(authz, id, body),
});
