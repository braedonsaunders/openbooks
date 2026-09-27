import { z } from "zod";
import { waiveMaterial } from "@openbooks/engine/src/manufacturing/completion.ts";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { can } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { manufacturingTransaction } from "../../../../../_transaction";
import { loadScopedWorkOrder } from "../../../../_scope";

const Params = z.object({ id: z.string().uuid(), materialId: z.string().uuid() });
const Body = z.object({ reason: z.string().trim().min(5).max(500) }).strict();

export const POST = defineRoute({
  permission: "items.post", feature: "manufacturing", params: Params, body: Body,
  handler: async ({ authz, params, body }) => manufacturingTransaction(authz.user.orgId, async () => {
    if (!can(authz, "manufacturing.manage")) {
      return Response.json({ error: "missing permission: manufacturing.manage" }, { status: 403 });
    }
    const scoped = await loadScopedWorkOrder(authz, params.id);
    if (!scoped.ok) return scoped.response;
    return Response.json(await waiveMaterial(db, authz.user.orgId, authz.user.id, params.id, params.materialId, body.reason));
  }),
});
