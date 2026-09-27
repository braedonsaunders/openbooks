import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { listAlerts } from "@openbooks/engine/src/hrm/qualifications/alerts.ts";
import { qualificationErrorResponse } from "../qualifications/_lib";
/** Fired expiry alerts (the scan writes them; the inbox consumes them). */
export const GET = defineRoute({
  permission: "hrm.certifications.read",
  feature: "hrmCertifications",
  handler: async ({ request: req, authz: gate }) => {
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
  },
});
