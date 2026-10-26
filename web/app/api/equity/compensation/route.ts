import { NextResponse } from "next/server";
import { z } from "zod";
import { listCompensationRuns, previewCompensationRun } from "@openbooks/engine/equity";
import { defineRoute } from "@/lib/api/route";
import { isoDate, uuidId } from "@/lib/api/json";
import { parseQuery } from "../_schema";

export const runtime = "nodejs";

const query = z.object({ subsidiaryId: uuidId, throughDate: isoDate() });

/** The stock compensation a run through the date would post, per award, beside the runs already posted. */
export const GET = defineRoute({
  permission: "equity.read",
  feature: "equity",
  handler: async ({ authz, request }) => {
    const parsed = parseQuery(request, query);
    if (!parsed.ok) return parsed.response;
    const input = { orgId: authz.user.orgId, actorId: authz.user.id, ...parsed.data };
    const preview = await previewCompensationRun(input);
    const runs = await listCompensationRuns(input);
    return NextResponse.json({ preview, runs });
  },
});
