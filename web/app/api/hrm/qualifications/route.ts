import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { db, withOrgTransaction } from "@openbooks/engine/src/platform/db.ts";
import {
  listQualifications,
  recordQualification,
} from "@openbooks/engine/src/hrm/qualifications/qualifications.ts";
import { qualificationErrorResponse } from "./_lib";
import { qualificationStatusFilter, recordQualificationBody } from "./bodies";
/** The worker qualification ledger: list (derived status at read) and record. */
export const GET = defineRoute({
  permission: "hrm.certifications.read",
  feature: "hrmCertifications",
  handler: async ({ request: req, authz: gate }) => {
    const params = new URL(req.url).searchParams;
    const statusRaw = params.get("status");
    const parsedStatus =
      statusRaw === null
        ? { success: true, data: undefined }
        : qualificationStatusFilter.safeParse(statusRaw);
    if (!parsedStatus.success) {
      return NextResponse.json(
        {
          error:
            "status must be one of valid, expiring, expired, revoked, pending_verification, not_yet_effective",
        },
        { status: 400 },
      );
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
  },
});
export const POST = defineRoute({
  permission: "hrm.certifications.manage",
  feature: "hrmCertifications",
  body: recordQualificationBody,
  handler: async ({ request: _req, authz: gate, body }) => {
    try {
      // The record and its evidence event commit together — one
      // transaction per user action, partial effects roll back.
      const qualification = await withOrgTransaction(gate.user.orgId, () =>
        recordQualification(db, {
          orgId: gate.user.orgId,
          actorId: gate.user.id,
          ...body,
        }),
      );
      return NextResponse.json({ qualification }, { status: 201 });
    } catch (e) {
      return qualificationErrorResponse(e);
    }
  },
});
