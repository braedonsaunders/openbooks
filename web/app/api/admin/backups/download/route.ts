import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * A one-response browser stream cannot deliver a separately authenticated
 * manifest after its SHA-256 becomes known. Refuse this legacy surface rather
 * than handing operators an archive the restore CLI cannot authenticate.
 */
function legacyGET() {
  return NextResponse.json(
    {
      error:
        "direct browser export is disabled because it cannot include restore-grade hash evidence",
      recovery:
        "create a stored backup and download both Archive and Manifest, or run src/backup/local-cli.ts from the engine directory",
    },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
}

export const GET = defineRoute({
  permission: "admin.backups.manage",
  feature: {
    none: "Backup downloads are governed by backup management permission and organization-wide backup policy.",
  },
  scope: "unrestricted",
  handler: legacyGET,
});
