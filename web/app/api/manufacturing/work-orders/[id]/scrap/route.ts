import { z } from "zod";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { recordNormalScrap } from "@openbooks/engine/src/manufacturing/scrap.ts";
import { manufacturingTransaction } from "../../../_transaction";
import { can } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
const Body = z
  .object({
    operationId: z.string().uuid(),
    quantity: z.string(),
    reasonId: z.string().uuid(),
  })
  .strict();
export const POST = defineRoute({
  permission: "items.post",
  feature: "manufacturing",
  params: z.object({ id: z.string().uuid() }),
  body: Body,
  handler: async ({ request, authz, params, body }) => {
    if (!can(authz, "manufacturing.manage"))
      return Response.json(
        { error: "missing permission: manufacturing.manage" },
        { status: 403 },
      );
    const key = z
      .string()
      .uuid()
      .safeParse(request.headers.get("Idempotency-Key"));
    if (!key.success)
      return Response.json(
        { error: "A UUID Idempotency-Key is required." },
        { status: 400 },
      );
    return manufacturingTransaction(authz.user.orgId, async () =>
      Response.json(
        await recordNormalScrap(
          db,
          authz.user.orgId,
          authz.user.id,
          authz.allowedSubsidiaryIds,
          params.id,
          key.data,
          body,
        ),
        { status: 201 },
      ),
    );
  },
});
