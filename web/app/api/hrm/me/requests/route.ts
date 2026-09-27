import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { getMyRequests } from "@openbooks/engine/src/hrm/self-service/self-read.ts";
import { meErrorResponse } from "../_lib";
/**
 * The caller's own change requests, newest first — the overview's pending
 * panel. Scoped by own employment ids in the engine.
 */
export const GET = defineRoute({
  permission: "hrm.self.read",
  feature: "hrm",
  handler: async ({ authz: gate }) => {
    try {
      const requests = await getMyRequests({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
      });
      return NextResponse.json({ requests });
    } catch (e) {
      return meErrorResponse(e);
    }
  },
});
