import { NextResponse } from "next/server";
import { downloadExport } from "@openbooks/engine/src/hrm/documents/dsar.ts";
import { guardPermission } from "../../../../../../lib/authz";
import { hrmDocumentsErrorResponse } from "../../../documents/_lib";

/** Download a ready export (subject or manage) — flips ready to delivered. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const hr = await guardPermission("hrm.documents.manage");
  const actor = hr instanceof NextResponse ? await guardPermission("hrm.self.read") : hr;
  if (actor instanceof NextResponse) return actor;
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
