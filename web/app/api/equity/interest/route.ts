import { NextResponse } from "next/server";
import { z } from "zod";
import { listInterestRuns, previewInterestRun } from "@openbooks/engine/equity";
import { defineRoute } from "@/lib/api/route";
import { isoDate, uuidId } from "@/lib/api/json";
import { parseQuery } from "../_schema";

export const runtime = "nodejs";

const query = z.object({ subsidiaryId: uuidId, throughDate: isoDate() });

/** The note interest a run through the date would accrue, per note, beside the runs already posted. */
export const GET = defineRoute({
  permission: "equity.read",
  feature: "equity",
  handler: async ({ authz, request }) => {
    const parsed = parseQuery(request, query);
    if (!parsed.ok) return parsed.response;
    const input = { orgId: authz.user.orgId, actorId: authz.user.id, ...parsed.data };
    const preview = await previewInterestRun(input);
    const runs = await listInterestRuns(input);
    return NextResponse.json({ preview, runs });
  },
});
