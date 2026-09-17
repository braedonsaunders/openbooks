import { NextResponse } from "next/server";
import { guardPermission } from "../../../../../../lib/authz";
import { createDbOwnedRunStore } from "../../../../../../lib/assistant/owned-runs-db";

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Explicitly stop an owned run. Runs are server-owned: closing the stream or
 * navigating away never stops them — only this endpoint (the Stop button)
 * or deleting the conversation does.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const gate = await guardPermission("assistant.use");
  if (gate instanceof NextResponse) return gate;
  const { runId } = await params;
  if (!UUID_RE.test(runId)) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const aborted = await createDbOwnedRunStore(gate).requestAbort(runId);
  if (!aborted) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
