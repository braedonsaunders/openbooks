import { z } from "zod";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { traceManufacturingGenealogy } from "@openbooks/engine/src/manufacturing/genealogy.ts";
import { defineRoute } from "@/lib/api/route";
import { manufacturingTransaction } from "../_transaction";

const Query = z.object({ kind: z.enum(["lot", "serial"]), id: z.string().uuid(), direction: z.enum(["forward", "backward"]), maxDepth: z.coerce.number().int().min(1).max(32).default(8) }).strict();
export const GET = defineRoute({
  permission: "manufacturing.read", feature: "manufacturing",
  handler: async ({ authz, request }) => {
    const parsed = Query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) return Response.json({ error: "Choose a lot or serial and a trace direction." }, { status: 422 });
    return manufacturingTransaction(authz.user.orgId, async () => Response.json(await traceManufacturingGenealogy(db, authz.user.orgId, authz.user.id, parsed.data, authz.allowedSubsidiaryIds)));
  },
});
