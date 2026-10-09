import { z } from "zod";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { withScopeSnapshot } from "@openbooks/engine/src/organization/subsidiary-scope.ts";
import {
  manufacturingOptions,
  searchManufacturingChoices,
} from "@openbooks/engine/src/manufacturing/workspace.ts";
import { can } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
const Query = z
  .object({
    kind: z.enum(["items", "locations", "vendors"]).optional(),
    q: z.string().max(200).optional(),
    selected: z.string().uuid().optional(),
  })
  .strict();
export const GET = defineRoute({
  permission: "manufacturing.read",
  feature: "manufacturing",
  handler: async ({ authz, request }) => {
    const input = Query.safeParse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    if (!input.success)
      return Response.json(
        { error: "Invalid manufacturing choice filters." },
        { status: 400 },
      );
    const { kind, q, selected } = input.data;
    if (kind === "vendors" && !can(authz, "ap.create"))
      return Response.json(
        { error: "missing permission: ap.create" },
        { status: 403 },
      );
    return withScopeSnapshot(authz.user.orgId, async () =>
      Response.json(
        kind
          ? await searchManufacturingChoices(
              db,
              authz.user.orgId,
              authz.allowedSubsidiaryIds,
              kind,
              q,
              selected,
            )
          : await manufacturingOptions(
              db,
              authz.user.orgId,
              authz.allowedSubsidiaryIds,
              can(authz, "ap.create"),
            ),
      ),
    );
  },
});
