import { z } from "zod";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { getManufacturingPolicies, updateManufacturingPolicies, type ManufacturingPoliciesInput } from "@openbooks/engine/src/manufacturing/policies.ts";
import { defineRoute } from "@/lib/api/route";
import { manufacturingTransaction } from "../_transaction";

const Body = z.object({
  shortagePolicy: z.enum(["warn", "refuse"]), completionTolerancePct: z.string(),
  abnormalScrapApprovalThreshold: z.string().nullable(),
});
const Params = z.object({}).strict();

export const GET = defineRoute({
  permission: "manufacturing.read", feature: "manufacturing", params: Params, scope: "unrestricted",
  handler: async ({ authz }) => manufacturingTransaction(authz.user.orgId, async () =>
    Response.json(await getManufacturingPolicies(db, authz.user.orgId))),
});

export const PUT = defineRoute({
  permission: "manufacturing.manage", feature: "manufacturing", params: Params, scope: "unrestricted", body: Body,
  handler: async ({ authz, body }) => manufacturingTransaction(authz.user.orgId, async () =>
    Response.json(await updateManufacturingPolicies(db, authz.user.orgId, authz.user.id, body as ManufacturingPoliciesInput))),
});
