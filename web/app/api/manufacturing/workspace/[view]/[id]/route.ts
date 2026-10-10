import { z } from "zod";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { withScopeSnapshot } from "@openbooks/engine/src/organization/subsidiary-scope.ts";
import { readManufacturingRecord } from "@openbooks/engine/src/manufacturing/workspace.ts";
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
