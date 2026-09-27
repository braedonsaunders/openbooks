import { NextResponse } from "next/server";
import { guardPermission } from "../../../../../lib/authz";
import { createDbOwnedRunStore } from "../../../../../lib/assistant/owned-runs-db";
import { notFound } from "@/lib/api/responses";
import { isUuid } from "@openbooks/engine/src/platform/uuid.ts";

export const runtime = "nodejs";

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
  if (!isUuid(runId)) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const run = await createDbOwnedRunStore(gate).readRun(runId);
  if (!run) return notFound("record");
  return NextResponse.json({ run });
}
