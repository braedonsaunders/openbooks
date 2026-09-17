import { NextResponse } from "next/server";
import { guardPermission } from "../../../../../lib/authz";
import { createDbOwnedRunStore } from "../../../../../lib/assistant/owned-runs-db";

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One owned run's event log, for clients reattaching after a switch, a tab
 * change, or a reload. Ownership-checked: a run is readable only by its
 * conversation's owner. Poll while status is "running"; the persisted
 * transcript carries terminal turns.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const gate = await guardPermission("assistant.use");
  if (gate instanceof NextResponse) return gate;
  const { runId } = await params;
  if (!UUID_RE.test(runId)) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const run = await createDbOwnedRunStore(gate).readRun(runId);
  if (!run) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ run });
}
