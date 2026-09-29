import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { restoreFolder } from "../../../../../../lib/file-cabinet";
import { isUuid } from "../../../../../../lib/list-params";
import { fileViewer, requireFolderAccess } from "../../../lib";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

/** Restore a trashed folder subtree. Needs Manager on the folder. */
export const POST = defineRoute({
  public: "session",
  params: z.object({ id: z.string() }),
  handler: async ({ request: _req, authz: gate, params }) => {
    const { id } = await params;
    if (!isUuid(id))
      return notFound("record");
    const access = await requireFolderAccess(gate, id, "manager");
    if (access) return access;
    const ok = await restoreFolder(gate.user.orgId, id, {
      actorId: gate.user.id,
      viewer: fileViewer(gate),
    });
    if (!ok) return notFound("record");
    return NextResponse.json({ ok: true });
  },
});
