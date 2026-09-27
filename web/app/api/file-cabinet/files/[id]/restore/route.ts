import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { restoreFile } from "../../../../../../lib/file-cabinet";
import { isUuid } from "../../../../../../lib/list-params";
import { fileViewer, requireFileAccess } from "../../../lib";
import { notFound } from "@/lib/api/responses";

export { runtime } from "@/lib/api/route";

/** Restore a trashed file. Needs Manager on the file. */
export const POST = defineRoute({
  public: "session",
  params: z.object({ id: z.string() }),
  handler: async ({ request: _req, authz: gate, params }) => {
    const { id } = await params;
    if (!isUuid(id))
      return notFound("record");
    const access = await requireFileAccess(gate, id, "manager", {
      includeInactive: true,
    });
    if (access) return access;
    const ok = await restoreFile(gate.user.orgId, id, {
      actorId: gate.user.id,
      viewer: fileViewer(gate),
    });
    if (!ok) return notFound("record");
    return NextResponse.json({ ok: true });
  },
});
