import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { findMrpRunRecord, listMrpRuns, runMrp } from "@openbooks/engine/manufacturing/mrp";
import { db } from "@openbooks/engine/platform/db";
import { guardSubsidiaryScope } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { idempotentManufacturingCreate } from "../../_idempotent";
import { manufacturingTransaction } from "../../_transaction";

const Params = z.object({}).strict();
const Body = z
  .object({
    subsidiaryId: uuidString(),
    horizonDays: z.number().int().min(1).max(366).optional(),
    capacityCheck: z.boolean().optional(),
  })
  .strict();

export const GET = defineRoute({
  permission: "manufacturing.read",
  feature: "manufacturingMrp",
  params: Params,
  handler: async ({ request, authz }) =>
    manufacturingTransaction(authz.user.orgId, async () => {
      const parsed = uuidString().safeParse(new URL(request.url).searchParams.get("subsidiaryId"));
      if (!parsed.success)
        return Response.json({ error: "subsidiaryId must be a UUID" }, { status: 400 });
      const denied = guardSubsidiaryScope(authz, parsed.data);
      if (denied) return denied;
      return Response.json(await listMrpRuns(db, authz.user.orgId, parsed.data));
    }),
});

export const POST = defineRoute({
  permission: "manufacturing.manage",
  feature: "manufacturingMrp",
  params: Params,
  body: Body,
  handler: async ({ request, authz, body }) =>
    manufacturingTransaction(authz.user.orgId, async () => {
      const denied = guardSubsidiaryScope(authz, body.subsidiaryId);
      if (denied) return denied;
      const match = {
        ...body,
        horizonDays: body.horizonDays ?? 90,
        capacityCheck: body.capacityCheck ?? true,
      };
      const run = await idempotentManufacturingCreate({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        request,
        table: "mfg_mrp_runs",
        match,
        create: (id) => runMrp(db, authz.user.orgId, authz.user.id, match, { id }),
        load: () =>
          findMrpRunRecord(
            db,
            authz.user.orgId,
            request.headers.get("Idempotency-Key")!.trim(),
            authz.user.id,
          ),
      });
      return Response.json(run, { status: 201 });
    }),
});
