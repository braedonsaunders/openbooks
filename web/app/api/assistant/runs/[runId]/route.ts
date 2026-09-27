import { NextResponse } from "next/server";
import { defineRoute } from "../../../../../lib/api/route";
import { createDbOwnedRunStore } from "../../../../../lib/assistant/owned-runs-db";
import { z } from "zod";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

/**
 * One owned run's event log, for clients reattaching after a switch, a tab
 * change, or a reload. Ownership-checked: a run is readable only by its
 * conversation's owner. Poll while status is "running"; the persisted
 * transcript carries terminal turns.
 */
export const GET = defineRoute({
  permission: "assistant.use",
  feature: { none: "Assistant access is controlled by assistant permissions and provider configuration." },
  params: z.object({ runId: z.string().uuid() }),
  handler: async ({ authz, params }) => {
  const { runId } = params;
  const run = await createDbOwnedRunStore(authz).readRun(runId);
  if (!run) return notFound("record");
  return NextResponse.json({ run });
  },
});
