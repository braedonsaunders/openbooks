import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { downloadExport } from "@openbooks/engine/src/hrm/documents/dsar.ts";
import { guardPermission } from "../../../../../../lib/authz";
import { hrmDocumentsErrorResponse } from "../../../documents/_lib";
import { gateExports } from "../../route";

/** Download a finished export (subject or manage) — ready flips to delivered; incomplete stays incomplete. */
export const GET = defineRoute({
  public: "session",
  params: z.object({ id: z.string().min(1) }),
  handler: async ({ request: _req, params: routeParams }) => {
    const hr = await guardPermission("hrm.documents.manage");
    const actor =
      hr instanceof NextResponse ? await guardPermission("hrm.self.read") : hr;
    if (actor instanceof NextResponse) return actor;
    // Gate like the sibling routes: a ready export must not stay
    // downloadable with HR documents (or HRM itself) switched off — this
    // is the route that hands over a subject's whole data zip.
    const gate = await gateExports(actor.user.orgId);
    if (gate) return gate;
    try {
      const { id } = routeParams;
      const file = await downloadExport({
        orgId: actor.user.orgId,
        actorId: actor.user.id,
        exportId: id,
      });
      return new NextResponse(file.bytes as unknown as BodyInit, {
        headers: {
          "content-type": "application/zip",
          "content-disposition": `attachment; filename="${file.filename}"`,
        },
      });
    } catch (e) {
      return hrmDocumentsErrorResponse(e);
    }
  },
});
