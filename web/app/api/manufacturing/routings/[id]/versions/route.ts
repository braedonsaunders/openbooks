import { z } from "zod";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { createNextRoutingVersion, getRouting } from "@openbooks/engine/src/manufacturing/routings.ts";
import { guardRoutingSubsidiaryScope } from "../../../_scope";
import { defineRoute } from "@/lib/api/route";
import { created, notFound } from "@/lib/api/responses";
import { idempotentManufacturingCreate } from "../../../_idempotent";
import { manufacturingTransaction } from "../../../_transaction";

const Params = z.object({ id: z.string().uuid() });
const Body = z.object({}).strict();

export const POST = defineRoute({
  permission: "manufacturing.manage", feature: "manufacturing", params: Params, body: Body,
  handler: async ({ request, authz, params }) => manufacturingTransaction(authz.user.orgId, async () => {
    const base = await getRouting(db, authz.user.orgId, params.id);
    if (!base) return notFound("routing");
    const denied = guardRoutingSubsidiaryScope(authz, base);
    if (denied) return denied;
    const row = await idempotentManufacturingCreate({
      orgId: authz.user.orgId, request, table: "mfg_routings", match: { baseRoutingId: params.id },
      create: (id, requestId, match) => createNextRoutingVersion(db, authz.user.orgId, authz.user.id, params.id, { id, requestId, match }),
      load: () => getRouting(db, authz.user.orgId, request.headers.get("Idempotency-Key")!.trim()),
    });
    return created(row);
  }),
});
