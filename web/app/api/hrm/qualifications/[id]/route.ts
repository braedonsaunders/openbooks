import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/src/platform/db.ts";
import {
  listQualificationEvents,
  loadQualification,
} from "@openbooks/engine/src/hrm/qualifications/qualifications.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { qualificationErrorResponse } from "../_lib";

export const runtime = "nodejs";

/** One qualification with its evidence trail (drawer reads this). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.certifications.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmCertifications"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    const id = (await params).id;
    const qualification = await loadQualification(db, {
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      qualificationId: id,
    });
    if (!qualification) {
      return NextResponse.json({ error: "The qualification was not found in this organization." }, { status: 404 });
    }
    const events = await listQualificationEvents(db, {
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      qualificationId: id,
    });
    return NextResponse.json({ qualification, events });
  } catch (e) {
    return qualificationErrorResponse(e);
  }
}
