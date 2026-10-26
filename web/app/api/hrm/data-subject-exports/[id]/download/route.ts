import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { fileContentDisposition } from "@/lib/export";
import { downloadExport } from "@openbooks/engine/hrm/documents/dsar";
import { hrmDocumentsErrorResponse } from "../../../documents/_lib";
import { authorizeExportAccess } from "../../route";

/** Download a finished export (subject or manage) — ready flips to delivered; incomplete stays incomplete. */
export const GET = defineRoute({
  authorize: authorizeExportAccess,
  feature: "hrmDocuments",
  params: z.object({ id: z.string().min(1) }),
  handler: async ({ authz: actor, params: routeParams }) => {
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
          "content-disposition": fileContentDisposition("attachment", file.filename),
        },
      });
    } catch (e) {
      return hrmDocumentsErrorResponse(e);
    }
  },
});
