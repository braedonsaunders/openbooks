import { z } from "zod";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { withScopeSnapshot } from "@openbooks/engine/src/organization/subsidiary-scope.ts";
import { manufacturingTracking } from "@openbooks/engine/src/manufacturing/workspace.ts";
import { defineRoute } from "@/lib/api/route";
export const GET = defineRoute({
  permission: "manufacturing.read",
  feature: "manufacturing",
  params: z.object({ itemId: z.string().uuid() }),
  handler: ({ authz, params, request }) =>
    withScopeSnapshot(authz.user.orgId, async () => {
      const query = z
        .object({
          q: z.string().max(200).optional(),
          lotId: z.string().uuid().optional(),
          selected: z.string().uuid().optional(),
        })
        .strict()
        .safeParse(Object.fromEntries(new URL(request.url).searchParams));
      if (!query.success)
        return Response.json(
          { error: "Invalid tracking filters." },
          { status: 400 },
        );
      return Response.json(
        await manufacturingTracking(
          db,
          authz.user.orgId,
          authz.allowedSubsidiaryIds,
          params.itemId,
          query.data,
        ),
      );
    }),
});
