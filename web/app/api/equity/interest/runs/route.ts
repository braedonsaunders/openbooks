import { NextResponse } from "next/server";
import { z } from "zod";
import { postInterestRun } from "@openbooks/engine/equity";
import { defineRoute } from "@/lib/api/route";
import { isoDate, uuidId } from "@/lib/api/json";

export const runtime = "nodejs";

const body = z.object({ subsidiaryId: uuidId, throughDate: isoDate() });

/**
 * Post the convertible note interest run through a date (equity.manage). A
 * run for a date already posted returns that run; nothing accrues twice.
 *
 * The run is submitted to any enabled Equity action Flow: it applies at
 * once (201) when no Flow gates it, and otherwise waits for the Flow's
 * decision (202, status pending_approval).
 */
export const POST = defineRoute({
  permission: "equity.manage",
  feature: "equity",
  body,
  invalidBodyStatus: 422,
  handler: async ({ authz, body }) => {
    const run = await postInterestRun({ orgId: authz.user.orgId, actorId: authz.user.id, ...body });
    return NextResponse.json(run, {
      status: run.status === "pending_approval" ? 202 : run.replayed ? 200 : 201,
    });
  },
});
