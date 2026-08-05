import { NextResponse } from "next/server";
import { oidcEnabled, oidcLabel } from "../../../../lib/auth-oidc";

export const runtime = "nodejs";

export function GET() {
  return NextResponse.json(
    { oidc: oidcEnabled(), oidcLabel: oidcLabel() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
