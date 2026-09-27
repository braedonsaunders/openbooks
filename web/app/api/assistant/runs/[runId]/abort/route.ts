import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { guardPermission } from "../../../../../../lib/authz";
import { createDbOwnedRunStore } from "../../../../../../lib/assistant/owned-runs-db";
import { notFound } from "@/lib/api/responses";
import { isUuid } from "@openbooks/engine/src/platform/uuid.ts";

export const runtime = "nodejs";

/**
 * Explicitly stop an owned run. Runs are server-owned: closing the stream or
 * navigating away never stops them — only this endpoint (the Stop button)
 * or deleting the conversation does.
 */
export async function POST(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const parsed = await parseJsonBody(req, jsonObject);
  if (!parsed.ok) return parsed.response;
  const gate = await guardPermission("assistant.use");
  if (gate instanceof NextResponse) return gate;
  const { runId } = await params;
  if (!isUuid(runId)) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const aborted = await createDbOwnedRunStore(gate).requestAbort(runId);
  if (!aborted) return notFound("record");
  return NextResponse.json({ ok: true });
}
