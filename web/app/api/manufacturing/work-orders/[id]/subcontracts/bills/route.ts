import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import { searchProductionServiceBills } from "@openbooks/engine/manufacturing/subcontract-workspace";
const params = z.object({ id: uuidString() }).strict();
export const GET = defineRoute({
  permission: "ap.read",
  feature: "manufacturingSubcontract",
  params,
  handler: ({ authz, params, request }) => {
    const query = z
      .object({
        contractId: uuidString(),
        q: z.string().max(200).optional(),
        selected: uuidString().optional(),
      })
      .strict()
      .safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!query.success)
      return Response.json(
        { error: "Choose a valid subcontract and bill search." },
        { status: 422 },
      );
    return withOrgTransaction(authz.user.orgId, async () =>
      Response.json(
        await searchProductionServiceBills(
          db,
          authz.user.orgId,
          authz.user.id,
          params.id,
          query.data.contractId,
          query.data.q ?? "",
          query.data.selected,
        ),
      ),
    );
  },
});
