import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { markWorkOrderDone } from "@openbooks/engine/manufacturing/completion";
import { db } from "@openbooks/engine/platform/db";
import { can } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { manufacturingTransaction } from "../../../_transaction";
import { loadScopedWorkOrder } from "../../_scope";

const Params = z.object({ id: uuidString() });
// Ordinary completion needs no override; short completion requires a reason
// under the service's quantity/tolerance checks.
const Body = z.union(
  [
    z
      .object({})
      .strict()
      .transform(() => ({ shortCloseReason: undefined })),
    z.object({ shortCloseReason: z.string().trim().min(5).max(500).nullable() }).strict(),
  ],
  {
    error:
      "Send an empty object for ordinary completion, or a shortCloseReason of 5–500 characters.",
  },
);

export const POST = defineRoute({
  permission: "items.post",
  feature: "manufacturing",
  params: Params,
  body: Body,
  invalidBodyStatus: 422,
  handler: async ({ authz, params, body }) =>
    manufacturingTransaction(authz.user.orgId, async () => {
      if (!can(authz, "manufacturing.manage")) {
        return Response.json(
          { error: "missing permission: manufacturing.manage" },
          { status: 403 },
        );
      }
      const scoped = await loadScopedWorkOrder(authz, params.id);
      if (!scoped.ok) return scoped.response;
      return Response.json(
        await markWorkOrderDone(db, authz.user.orgId, authz.user.id, params.id, body),
      );
    }),
});
