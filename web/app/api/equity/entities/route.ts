import { NextResponse } from "next/server";
import { listEquityEntities } from "@openbooks/engine/equity";
import { defineRoute } from "@/lib/api/route";

export const runtime = "nodejs";

/** Legal entities whose equity the caller can read. */
export const GET = defineRoute({
  permission: "equity.read",
  feature: "equity",
  handler: async ({ authz }) =>
    NextResponse.json({
      entities: await listEquityEntities({ orgId: authz.user.orgId, actorId: authz.user.id }),
    }),
});
