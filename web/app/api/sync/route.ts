import { NextResponse } from "next/server";
import { configuredSources, sourceByName } from "@openbooks/engine/src/sync/registry.ts";
import { runSync } from "@openbooks/engine/src/sync/sync.ts";

export const runtime = "nodejs";
export const maxDuration = 300;

let inFlight: Promise<unknown> | null = null;

export async function GET() {
  return NextResponse.json({
    sources: configuredSources().map((s) => ({ name: s.name, displayName: s.displayName })),
  });
}

export async function POST(req: Request) {
  if (inFlight) {
    return NextResponse.json({ error: "a sync is already running" }, { status: 409 });
  }
  try {
    const body = await req.json().catch(() => ({}));
    const requested = (body as { source?: string }).source;
    const cfg = requested ? sourceByName(requested) : configuredSources()[0];
    if (!cfg) {
      return NextResponse.json({ error: "no external source configured" }, { status: 400 });
    }
    inFlight = runSync(cfg.make(), "ui");
    const result = await inFlight;
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  } finally {
    inFlight = null;
  }
}
