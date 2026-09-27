import { NextResponse } from "next/server";
import { defineRoute } from "../../../../../../lib/api/route";
import { createDbOwnedRunStore } from "../../../../../../lib/assistant/owned-runs-db";
import { z } from "zod";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

/**
 * Explicitly stop an owned run. Runs are server-owned: closing the stream or
 * navigating away never stops them — only this endpoint (the Stop button)
 * or deleting the conversation does.
 */
export const POST = defineRoute({
  permission: "assistant.use",
  feature: { none: "Assistant access is controlled by assistant permissions and provider configuration." },
  params: z.object({ runId: z.string().uuid() }),
  handler: async ({ authz, params }) => {
  const { runId } = params;
  const aborted = await createDbOwnedRunStore(authz).requestAbort(runId);
  if (!aborted) return notFound("record");
  return NextResponse.json({ ok: true });
  },
});
