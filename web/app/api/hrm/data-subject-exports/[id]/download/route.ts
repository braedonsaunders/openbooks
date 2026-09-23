import { NextResponse } from "next/server";
import { downloadExport } from "@openbooks/engine/src/hrm/documents/dsar.ts";
import { guardPermission } from "../../../../../../lib/authz";
import { hrmDocumentsErrorResponse } from "../../../documents/_lib";
import { gateExports } from "../../route";

/** Download a finished export (subject or manage) — ready flips to delivered; incomplete stays incomplete. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const hr = await guardPermission("hrm.documents.manage");
  const actor = hr instanceof NextResponse ? await guardPermission("hrm.self.read") : hr;
  if (actor instanceof NextResponse) return actor;
  // The sibling routes gate; this one did not, so a ready export stayed
  // downloadable with hrmDataSubjectExport (or hrm itself) switched off —
  // and this is the route that hands over a subject's whole data zip.
  const gate = await gateExports(actor.user.orgId);
  if (gate) return gate;
  try {
    const { id } = await ctx.params;
    const file = await downloadExport({ orgId: actor.user.orgId, actorId: actor.user.id, exportId: id });
    return new NextResponse(file.bytes as unknown as BodyInit, {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${file.filename}"`,
      },
    });
  } catch (e) {
    return hrmDocumentsErrorResponse(e);
  }
}
