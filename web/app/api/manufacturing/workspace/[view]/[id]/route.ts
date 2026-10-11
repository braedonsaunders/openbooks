import { z } from "zod";
import { db } from "@openbooks/engine/platform/db";
import { withScopeSnapshot } from "@openbooks/engine/organization/scope";
import { readManufacturingRecord } from "@openbooks/engine/manufacturing/workspace";
import { defineRoute } from "@/lib/api/route";
const Params = z.object({
  view: z.enum(["work-orders", "work-centers", "routings", "mrp"]),
  id: z.string().uuid(),
});
export const GET = defineRoute({
  permission: "manufacturing.read",
  feature: "manufacturing",
  params: Params,
  handler: ({ authz, params }) =>
    withScopeSnapshot(authz.user.orgId, async () =>
      Response.json(
        await readManufacturingRecord(
          db,
          authz.user.orgId,
          authz.allowedSubsidiaryIds,
          params.view,
          params.id,
          authz.user.id,
        ),
      ),
    ),
});
