import { z } from "zod";
import { NextResponse } from "next/server";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { db } from "@openbooks/engine/platform/db";
import { traceManufacturingGenealogy } from "@openbooks/engine/manufacturing/genealogy";
import { can, guardPermission } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { manufacturingTransaction } from "../_transaction";

const Query = z
  .object({
    kind: z.enum(["lot", "serial"]),
    id: uuidString(),
    direction: z.enum(["forward", "backward"]),
    maxDepth: z.coerce.number().int().min(1).max(32).default(8),
  })
  .strict();
export const GET = defineRoute({
  authorize: async () => {
    const authz = await guardPermission("manufacturing.read");
    if (authz instanceof NextResponse) return authz;
    return can(authz, "items.read")
      ? authz
      : NextResponse.json({ error: "missing permission: items.read" }, { status: 403 });
  },
  feature: "manufacturing",
  handler: async ({ authz, request }) => {
    const parsed = Query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success)
      return Response.json(
        { error: "Choose a lot or serial and a trace direction." },
        { status: 422 },
      );
    return manufacturingTransaction(authz.user.orgId, async () =>
      Response.json(
        await traceManufacturingGenealogy(
          db,
          authz.user.orgId,
          authz.user.id,
          parsed.data,
          authz.allowedSubsidiaryIds,
        ),
      ),
    );
  },
});
