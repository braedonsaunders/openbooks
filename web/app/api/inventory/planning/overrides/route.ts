import { z } from "zod";
import { listForecastOverrides, saveForecastOverride } from "@openbooks/engine/inventory";
import { db } from "@openbooks/engine/platform/database";
import { guardSubsidiaryScope } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { planningTransaction } from "../_transaction";

const Params = z.object({}).strict();
const Body = z.object({
  itemId: z.string().uuid(),
  stockLocationId: z.string().uuid(),
  subsidiaryId: z.string().uuid(),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  quantity: z.string(),
  reason: z.string().min(5).max(500),
}).strict();

export const GET = defineRoute({
  permission: "inventory.plan", feature: "demandPlanning", params: Params,
  handler: async ({ request, authz }) => planningTransaction(authz.user.orgId, async () => {
    const url = new URL(request.url);
    const subsidiary = z.string().uuid().safeParse(url.searchParams.get("subsidiaryId"));
    const runId = z.string().uuid().safeParse(url.searchParams.get("runId"));
    if (!subsidiary.success || !runId.success) {
      return Response.json({ error: "subsidiaryId and runId must be UUIDs" }, { status: 400 });
    }
    const denied = guardSubsidiaryScope(authz, subsidiary.data);
    if (denied) return denied;
    return Response.json(await listForecastOverrides(db, authz.user.orgId, subsidiary.data, runId.data));
  }),
});

export const POST = defineRoute({
  permission: "inventory.plan", feature: "demandPlanning", params: Params, body: Body,
  handler: async ({ authz, body }) => planningTransaction(authz.user.orgId, async () => {
    const denied = guardSubsidiaryScope(authz, body.subsidiaryId);
    if (denied) return denied;
    const { subsidiaryId: _subsidiaryId, ...override } = body;
    return Response.json(await saveForecastOverride(db, authz.user.orgId, authz.user.id, override), { status: 201 });
  }),
});
