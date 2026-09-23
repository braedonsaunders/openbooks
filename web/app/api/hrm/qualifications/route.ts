import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { db, withOrgTransaction } from "@openbooks/engine/src/platform/db.ts";
import {
  listQualifications,
  recordQualification,
} from "@openbooks/engine/src/hrm/qualifications/qualifications.ts";
import { guardPermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { qualificationErrorResponse } from "./_lib";
import { qualificationStatusFilter, recordQualificationBody } from "./bodies";

export const runtime = "nodejs";

/** The worker qualification ledger: list (derived status at read) and record. */
export async function GET(req: Request) {
  const gate = await guardPermission("hrm.certifications.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmCertifications"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const params = new URL(req.url).searchParams;
  const statusRaw = params.get("status");
  const parsedStatus = statusRaw === null ? { success: true, data: undefined } : qualificationStatusFilter.safeParse(statusRaw);
  if (!parsedStatus.success) {
    return NextResponse.json({ error: "status must be one of valid, expiring, expired, revoked, pending_verification, not_yet_effective" }, { status: 400 });
  }
  const status = parsedStatus.data;
  try {
    const qualifications = await listQualifications(db, {
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      employmentId: params.get("employmentId") ?? undefined,
      typeId: params.get("typeId") ?? undefined,
      status,
    });
    return NextResponse.json({ qualifications });
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
  const parsedBody = await parseJsonBody(req, recordQualificationBody);
  if (!parsedBody.ok) return parsedBody.response;
  try {
    // The record and its evidence event commit together — one
    // transaction per user action, partial effects roll back.
    const qualification = await withOrgTransaction(gate.user.orgId, () =>
      recordQualification(db, {
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        ...parsedBody.data,
      }),
    );
    return NextResponse.json({ qualification }, { status: 201 });
  } catch (e) {
    return qualificationErrorResponse(e);
  }
}
