import { createPrepaidGrant, listPrepaidGrants } from "@openbooks/engine/src/billing/usage/prepaid.ts";
import { businessToday } from "@openbooks/engine/src/platform/business-date.ts";
import { defineRoute } from "@/lib/api/route";
import { idempotentUsageCreate } from "../_idempotent";
import { z } from "zod";

const Query = z.object({ asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).strict();
const Body = z.object({
  customerId: z.string().uuid(),
  sourceDocumentLineId: z.string().uuid(),
  amount: z.string(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
}).strict();

export const GET = defineRoute({
  permission: "usage.read",
  feature: "usageBilling",
  handler: async ({ request, authz }) => {
    const parsed = Query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) return Response.json({ error: "Invalid prepaid grant filters" }, { status: 400 });
    const asOf = parsed.data.asOf ?? await businessToday(authz.user.orgId);
    return Response.json(await listPrepaidGrants(authz.user.orgId, asOf, authz.allowedSubsidiaryIds));
  },
});

export const POST = defineRoute({
  permission: "usage.manage",
  feature: "usageBilling",
  body: Body,
  handler: async ({ request, authz, body }) => idempotentUsageCreate({
    request, authz, operation: "usage.prepaid_grant.create", requestBody: body,
    execute: () => createPrepaidGrant(authz.user.orgId, authz.user.id, body, authz.allowedSubsidiaryIds),
  }),
});
