import { replaceUsageRatingBands } from "@openbooks/engine/src/billing/usage/rating-plans.ts";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";

const Band = z.object({
  meterId: z.string().uuid(),
  kind: z.enum(["graduated", "volume", "package", "overage", "commit_shortfall", "prepaid_drawdown"]),
  seq: z.number().int().positive(),
  upToQty: z.string().nullable(),
  unitPrice: z.string(),
  flatAmount: z.string().optional(),
  includedQty: z.string().optional(),
  packageSize: z.string().nullable().optional(),
  packageRounding: z.enum(["up", "down"]).nullable().optional(),
}).strict();
const Params = z.object({ id: z.string().uuid() }).strict();
const Body = z.object({ bands: z.array(Band).max(500) }).strict();

export const PUT = defineRoute({
  permission: "usage.manage",
  feature: "usageBilling",
  scope: "unrestricted",
  params: Params,
  body: Body,
  handler: async ({ authz, params, body }) => Response.json(await replaceUsageRatingBands(
    authz.user.orgId,
    authz.user.id,
    params.id,
    body.bands,
  )),
});
