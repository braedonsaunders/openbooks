import { NextResponse } from "next/server";
import { loadStructure } from "@openbooks/engine/equity";
import { defineRoute } from "@/lib/api/route";
import { entityQuery, parseQuery } from "../_schema";

export const runtime = "nodejs";

/** Share classes (with amendments and splits), plans (with pools) and rounds of a legal entity. */
export const GET = defineRoute({
  permission: "equity.read",
  feature: "equity",
  handler: async ({ authz, request }) => {
    const query = parseQuery(request, entityQuery);
    if (!query.ok) return query.response;
    return NextResponse.json(
      await loadStructure({ orgId: authz.user.orgId, actorId: authz.user.id, ...query.data }),
    );
  },
});
