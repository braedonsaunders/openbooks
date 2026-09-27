import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { guardPermission } from "../../../../../lib/authz";

export const runtime = "nodejs";

/**
 * A one-response browser stream cannot deliver a separately authenticated
 * manifest after its SHA-256 becomes known. Refuse this legacy surface rather
 * than handing operators an archive the restore CLI cannot authenticate.
 */
async function legacyGET() {
  const gate = await guardPermission("admin.backups.manage");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json(
    {
      error: "direct browser export is disabled because it cannot include restore-grade hash evidence",
      recovery: "create a stored backup and download both Archive and Manifest, or run src/backup/local-cli.ts from the engine directory",
    },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
}

export const GET = defineRoute({
  permission: "admin.backups.manage",
  feature: { none: "This endpoint has no single route-wide feature gate; its handler retains any action-specific feature checks." },
  handler: async () => legacyGET(),
});
