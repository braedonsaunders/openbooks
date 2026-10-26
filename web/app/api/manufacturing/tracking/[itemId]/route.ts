import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { db } from "@openbooks/engine/platform/db";
import { withScopeSnapshot } from "@openbooks/engine/organization/scope";
import { manufacturingTracking } from "@openbooks/engine/manufacturing/workspace";
import { defineRoute } from "@/lib/api/route";
export const GET = defineRoute({
  permission: "manufacturing.read",
  feature: "manufacturing",
  params: z.object({ itemId: uuidString() }),
  handler: ({ authz, params, request }) =>
    withScopeSnapshot(authz.user.orgId, async () => {
      const query = z
        .object({
          q: z.string().max(200).optional(),
          lotId: uuidString().optional(),
          selected: uuidString().optional(),
        })
        .strict()
        .safeParse(Object.fromEntries(new URL(request.url).searchParams));
      if (!query.success)
        return Response.json({ error: "Invalid tracking filters." }, { status: 400 });
      return Response.json(
        await manufacturingTracking(
          db,
          authz.user.orgId,
          authz.allowedSubsidiaryIds,
          params.itemId,
          query.data,
          authz.user.id,
        ),
      );
    }),
});
