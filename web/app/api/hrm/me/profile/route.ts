import { NextResponse } from "next/server";
import { getMyProfile } from "@openbooks/engine/src/hrm/self-service/self-read.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { meErrorResponse } from "../_lib";

export const runtime = "nodejs";

/**
 * The caller's own profile: party contact fields, the profile address, and
 * one as-of employment summary per own employment. Scoped by the party
 * behind the login in the engine — there is no id parameter to forge.
 */
export async function GET() {
  const gate = await guardPermission("hrm.self.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    const profile = await getMyProfile({ orgId: gate.user.orgId, actorId: gate.user.id });
    return NextResponse.json({ profile });
  } catch (e) {
    return meErrorResponse(e);
  }
}
