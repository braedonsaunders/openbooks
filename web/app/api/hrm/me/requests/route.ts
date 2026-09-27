import { NextResponse } from "next/server";
import { getMyRequests } from "@openbooks/engine/src/hrm/self-service/self-read.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { meErrorResponse } from "../_lib";
import { notFound } from "@/lib/api/responses";


export const runtime = "nodejs";

/**
 * The caller's own change requests, newest first — the overview's pending
 * panel. Scoped by own employment ids in the engine.
 */
export async function GET() {
  const gate = await guardPermission("hrm.self.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return notFound("record");
  }
  try {
    const requests = await getMyRequests({ orgId: gate.user.orgId, actorId: gate.user.id });
    return NextResponse.json({ requests });
  } catch (e) {
    return meErrorResponse(e);
  }
}
