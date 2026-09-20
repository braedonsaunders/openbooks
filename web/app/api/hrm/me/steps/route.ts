import { NextResponse } from "next/server";
import { getMySteps } from "@openbooks/engine/src/hrm/self-service/self-read.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { meErrorResponse } from "../_lib";

export const runtime = "nodejs";

/**
 * The caller's own open checklist steps. Completion rides the existing
 * step endpoint — this read names the rows, never completes them.
 */
export async function GET() {
  const gate = await guardPermission("hrm.self.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    const steps = await getMySteps({ orgId: gate.user.orgId, actorId: gate.user.id });
    return NextResponse.json({ steps });
  } catch (e) {
    return meErrorResponse(e);
  }
}
