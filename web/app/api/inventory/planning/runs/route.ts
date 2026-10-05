import { z } from "zod";
import { listDemandRuns, runDemandPlan } from "@openbooks/engine/inventory";
import { db } from "@openbooks/engine/platform/database";
import { guardSubsidiaryScope } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { planningTransaction } from "../_transaction";

const Params = z.object({}).strict();
const Body = z.object({
  subsidiaryId: z.string().uuid(),
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  horizonWeeks: z.number().int().min(1).max(52).optional(),
  historyWeeks: z.number().int().min(4).max(156).optional(),
}).strict();

export const GET = defineRoute({
  permission: "inventory.plan", feature: "demandPlanning", params: Params,
  handler: async ({ request, authz }) => planningTransaction(authz.user.orgId, async () => {
    const parsed = z.string().uuid().safeParse(new URL(request.url).searchParams.get("subsidiaryId"));
    if (!parsed.success) return Response.json({ error: "subsidiaryId must be a UUID" }, { status: 400 });
    const denied = guardSubsidiaryScope(authz, parsed.data);
    if (denied) return denied;
    return Response.json(await listDemandRuns(db, authz.user.orgId, parsed.data));
  }),
});

export const POST = defineRoute({
  permission: "inventory.plan", feature: "demandPlanning", params: Params, body: Body,
  handler: async ({ request, authz, body }) => planningTransaction(authz.user.orgId, async () => {
    const denied = guardSubsidiaryScope(authz, body.subsidiaryId);
    if (denied) return denied;
    const run = await runDemandPlan(db, authz.user.orgId, authz.user.id, {
      subsidiaryId: body.subsidiaryId,
      asOf: body.asOf,
      horizonWeeks: body.horizonWeeks,
      historyWeeks: body.historyWeeks,
      idempotencyKey: request.headers.get("Idempotency-Key")?.trim() || undefined,
    });
    return Response.json(run, { status: run.replayed ? 200 : 201 });
  }),
});
