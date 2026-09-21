import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { listAlerts } from "@openbooks/engine/src/hrm/qualifications/alerts.ts";
import { guardPermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { qualificationErrorResponse } from "../qualifications/_lib";

export const runtime = "nodejs";

/** Fired expiry alerts (the scan writes them; the inbox consumes them). */
export async function GET(req: Request) {
  const gate = await guardPermission("hrm.certifications.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmCertifications"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const params = new URL(req.url).searchParams;
  try {
    const alerts = await listAlerts(db, {
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      employmentId: params.get("employmentId") ?? undefined,
      unsentOnly: params.get("unsentOnly") === "1",
    });
    return NextResponse.json({ alerts });
  } catch (e) {
    return qualificationErrorResponse(e);
  }
}
