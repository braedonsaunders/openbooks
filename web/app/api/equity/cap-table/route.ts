import { NextResponse } from "next/server";
import { loadCapTableView } from "@openbooks/engine/equity";
import { defineRoute } from "@/lib/api/route";
import { entityQuery, parseQuery } from "../_schema";

export const runtime = "nodejs";

/** The legal entity's cap table as of a date: classes, holders, plans, holdings and convertibles. */
export const GET = defineRoute({
  permission: "equity.read",
  feature: "equity",
  handler: async ({ authz, request }) => {
    const query = parseQuery(request, entityQuery);
    if (!query.ok) return query.response;
    return NextResponse.json(
      await loadCapTableView({ orgId: authz.user.orgId, actorId: authz.user.id, ...query.data }),
    );
  },
});
