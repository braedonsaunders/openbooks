import { NextResponse } from "next/server";
import { z } from "zod";
import { loadSecurityDetail } from "@openbooks/engine/equity";
import { defineRoute } from "@/lib/api/route";
import { isoDate, uuidId } from "@/lib/api/json";
import { parseQuery } from "../../_schema";

export const runtime = "nodejs";

const params = z.object({ id: uuidId });
const query = z.object({ asOf: isoDate() });

/** One security: terms, state as of a date, vesting schedule, cost and history. */
export const GET = defineRoute({
  permission: "equity.read",
  feature: "equity",
  params,
  invalidParamsNotFound: "record",
  handler: async ({ authz, params: { id }, request }) => {
    const parsed = parseQuery(request, query);
    if (!parsed.ok) return parsed.response;
    return NextResponse.json(
      await loadSecurityDetail({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        securityId: id,
        asOf: parsed.data.asOf,
      }),
    );
  },
});
