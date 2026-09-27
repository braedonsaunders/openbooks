import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { isUuid } from "../../../../../../lib/list-params";
import { listFileActivity } from "../../../../../../lib/file-audit";
import { requireFileAccess } from "../../../lib";
import { notFound } from "@/lib/api/responses";

export { runtime } from "@/lib/api/route";

/** Activity history for a file. Requires at least Viewer access. */
export const GET = defineRoute({
  public: "session",
  params: z.object({ id: z.string() }),
  handler: async ({ request: _req, authz: gate, params }) => {
    const { id } = await params;
    if (!isUuid(id))
      return notFound("record");
    const access = await requireFileAccess(gate, id, "viewer");
    if (access) return access;
    const entries = await listFileActivity(gate.user.orgId, "files", id);
    return NextResponse.json({ entries });
  },
});
