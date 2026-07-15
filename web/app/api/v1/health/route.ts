import { NextResponse } from "next/server";

export const runtime = "nodejs";

/** Liveness probe — no authentication required. */
export async function GET() {
  return NextResponse.json({ status: "ok", service: "openbooks-api", version: "1.0.0" });
}
