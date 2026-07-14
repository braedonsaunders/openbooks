import { NextResponse } from "next/server";
import { NetSuiteSource } from "@openbooks/engine/src/sync/netsuite-source.ts";
import { runSync } from "@openbooks/engine/src/sync/sync.ts";

export const runtime = "nodejs";
export const maxDuration = 300;

let inFlight: Promise<unknown> | null = null;

export async function POST() {
  if (inFlight) {
    return NextResponse.json({ error: "a sync is already running" }, { status: 409 });
  }
  try {
    inFlight = runSync(new NetSuiteSource(), "ui");
    const result = await inFlight;
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  } finally {
    inFlight = null;
  }
}
