import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { loadSettings, setAlertSchedule } from "@openbooks/engine/src/hrm/qualifications/types.ts";
import { guardPermission, guardUnrestrictedScope } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { qualificationErrorResponse } from "../qualifications/_lib";

export const runtime = "nodejs";

const setScheduleBody = z.object({
  leadDays: z.array(z.number().int().positive()).min(1).max(12),
});

/**
 * The org's qualification settings: vocabulary + alert schedule.
 *
 * The schedule is org-wide policy with no subsidiary lineage — one write
 * re-times every entity's expiry alerts at once — so POST needs
 * unrestricted subsidiary scope (canonical shape 2): restricted callers get
 * the named 403 and store nothing. GET stays open to every
 * hrm.certifications.read holder: the schedule and vocabulary disclose no
 * per-subsidiary material, and managers need the lead days to act on alerts.
 */
export async function GET() {
  const gate = await guardPermission("hrm.certifications.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmCertifications"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    const settings = await loadSettings(db, gate.user.orgId);
    return NextResponse.json({ settings });
  } catch (e) {
    return qualificationErrorResponse(e);
  }
}

export async function POST(req: Request) {
  const gate = await guardPermission("hrm.certifications.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmCertifications"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const scopeDenied = guardUnrestrictedScope(gate);
  if (scopeDenied) return scopeDenied;
  const parsedBody = await parseJsonBody(req, setScheduleBody);
  if (!parsedBody.ok) return parsedBody.response;
  try {
    const settings = await setAlertSchedule(db, {
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      ...parsedBody.data,
    });
    return NextResponse.json({ settings });
  } catch (e) {
    return qualificationErrorResponse(e);
  }
}
