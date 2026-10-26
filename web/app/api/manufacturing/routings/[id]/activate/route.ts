import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { db } from "@openbooks/engine/platform/db";
import { submitRoutingActivation, getRouting } from "@openbooks/engine/manufacturing/routings";
import { guardRoutingSubsidiaryScope } from "../../../_scope";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { manufacturingTransaction } from "../../../_transaction";

const Params = z.object({ id: uuidString() });
const Body = z
  .object({
    subsidiaryId: uuidString(),
    reason: z.string().trim().min(8).max(500),
  })
  .strict();

export const POST = defineRoute({
  permission: "manufacturing.manage",
  scope: "unrestricted",
  feature: "manufacturing",
  params: Params,
  body: Body,
  handler: async ({ authz, params, body, request }) =>
    manufacturingTransaction(authz.user.orgId, async () => {
      const current = await getRouting(db, authz.user.orgId, params.id);
      if (!current) return notFound("routing");
      const denied = guardRoutingSubsidiaryScope(authz, current);
      if (denied) return denied;
      const key = uuidString().safeParse(request.headers.get("Idempotency-Key"));
      if (!key.success)
        return Response.json({ error: "Provide a UUID Idempotency-Key." }, { status: 400 });
      return Response.json(
        await submitRoutingActivation(db, authz.user.orgId, authz.user.id, params.id, {
          ...body,
          idempotencyKey: key.data,
        }),
      );
    }),
});
