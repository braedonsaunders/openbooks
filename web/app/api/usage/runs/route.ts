import { commitRateRun, listRateRuns } from "@openbooks/engine/src/billing/usage/rate-run.ts";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";

const Query = z.object({
  customerId: z.string().uuid().optional(),
  linkId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
}).strict();
const Body = z.object({
  linkId: z.string().uuid(),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strict();

export const GET = defineRoute({
  permission: "usage.read",
  feature: "usageBilling",
  handler: async ({ request, authz }) => {
    const parsed = Query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) return Response.json({ error: "Invalid usage rating run filters" }, { status: 400 });
    return Response.json(await listRateRuns(authz.user.orgId, parsed.data, authz.allowedSubsidiaryIds));
  },
});

export const POST = defineRoute({
  permission: "usage.bill",
  feature: "usageBilling",
  body: Body,
  handler: async ({ authz, body }) => Response.json(await commitRateRun(
    authz.user.orgId,
    authz.user.id,
    body.linkId,
    body.periodStart,
    body.periodEnd,
    authz.allowedSubsidiaryIds,
  )),
});
