import { NextResponse } from "next/server";
import { getMyBenefitsWorkspace } from "@openbooks/engine/src/hrm/self-service/my-work.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { meErrorResponse } from "../_lib";

export const runtime = "nodejs";

/**
 * The caller's own benefits: elections with the stored payroll amounts,
 * the open windows covering their employer, dependents on file, and the
 * plans offered to their subsidiary. Amounts are the stored per-period
 * figures — never recomputed here.
 */
export async function GET() {
  const gate = await guardPermission("hrm.self.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    const workspace = await getMyBenefitsWorkspace({ orgId: gate.user.orgId, actorId: gate.user.id });
    return NextResponse.json({ workspace });
  } catch (e) {
    return meErrorResponse(e);
  }
}
