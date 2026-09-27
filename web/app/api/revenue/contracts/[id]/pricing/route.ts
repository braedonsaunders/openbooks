import { getContractPricingSubsidiary, setContractPricing } from "@openbooks/engine/src/revenue/recognition-transaction-price.ts";
import { defineRoute } from "@/lib/api/route";
import { guardSubsidiaryScope } from "@/lib/authz";
import { notFound } from "@/lib/api/responses";
import { z } from "zod";

const Params = z.object({ id: z.string().uuid() }).strict();
const Variable = z.object({
  method: z.enum(["expected_value", "most_likely_amount"]),
  outcomes: z.array(z.object({ amount: z.string(), probabilityPercent: z.string() }).strict()).min(1).max(100),
  constraintLimit: z.string().nullable().optional(),
}).strict();
const Body = z.object({
  fixedConsideration: z.string(),
  variable: Variable.nullable().optional(),
  financing: z.object({ annualRatePercent: z.string(), years: z.number().int() }).strict().nullable().optional(),
}).strict();

export const PUT = defineRoute({
  permission: "ar.post",
  feature: "revenueRecognition",
  params: Params,
  body: Body,
  handler: async ({ authz, params, body }) => {
    const subsidiaryId = await getContractPricingSubsidiary(authz.user.orgId, params.id);
    if (subsidiaryId === undefined) return notFound("contract");
    const denied = guardSubsidiaryScope(authz, subsidiaryId);
    if (denied) return denied;
    return Response.json(await setContractPricing(
      authz.user.orgId,
      params.id,
      body,
      authz.user.id,
      authz.allowedSubsidiaryIds,
    ));
  },
});
