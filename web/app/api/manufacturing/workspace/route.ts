import { z } from "zod";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { withScopeSnapshot } from "@openbooks/engine/src/organization/subsidiary-scope.ts";
import { listManufacturingRecords } from "@openbooks/engine/src/manufacturing/workspace.ts";
import { defineRoute } from "@/lib/api/route";
const Query = z
  .object({
    view: z.enum(["work-orders", "work-centers", "routings", "mrp"]),
    page: z.coerce.number().int().positive().optional(),
    perPage: z.coerce.number().int().min(10).max(100).optional(),
    q: z.string().max(200).optional(),
    status: z.string().max(30).optional(),
    subsidiaryId: z.string().uuid().optional(),
  })
  .strict();
export const GET = defineRoute({
  permission: "manufacturing.read",
  feature: "manufacturing",
  handler: async ({ authz, request }) => {
    const parsed = Query.safeParse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    if (!parsed.success)
      return Response.json(
        { error: "Invalid manufacturing list filters." },
        { status: 400 },
      );
    const { view, ...input } = parsed.data;
    return withScopeSnapshot(authz.user.orgId, async () =>
      Response.json(
        await listManufacturingRecords(
          db,
          authz.user.orgId,
          authz.allowedSubsidiaryIds,
          view,
          input,
        ),
      ),
    );
  },
});
