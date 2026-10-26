import { lockManufacturingRoutingAuthority } from "@openbooks/engine/manufacturing/authority";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { db } from "@openbooks/engine/platform/db";
import { createNextRoutingVersion, getRouting } from "@openbooks/engine/manufacturing/routings";
import { guardRoutingSubsidiaryScope } from "../../../_scope";
import { defineRoute } from "@/lib/api/route";
import { created, notFound } from "@/lib/api/responses";
import { idempotentManufacturingCreate } from "../../../_idempotent";
import { manufacturingTransaction } from "../../../_transaction";

const Params = z.object({ id: uuidString() });
const Body = z.object({}).strict();

export const POST = defineRoute({
  permission: "manufacturing.manage",
  feature: "manufacturing",
  params: Params,
  body: Body,
  handler: async ({ request, authz, params }) =>
    manufacturingTransaction(authz.user.orgId, async () => {
      const base = await getRouting(db, authz.user.orgId, params.id);
      if (!base) return notFound("routing");
      const denied = guardRoutingSubsidiaryScope(authz, base);
      if (denied) return denied;
      const row = await idempotentManufacturingCreate({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        request,
        table: "mfg_routings",
        match: { baseRoutingId: params.id },
        create: (id, requestId, match) =>
          createNextRoutingVersion(db, authz.user.orgId, authz.user.id, params.id, {
            id,
            requestId,
            match,
          }),
        load: async () => {
          const id = request.headers.get("Idempotency-Key")!.trim();
          await lockManufacturingRoutingAuthority(db, authz.user.orgId, authz.user.id, id);
          return getRouting(db, authz.user.orgId, id);
        },
      });
      return created(row);
    }),
});
