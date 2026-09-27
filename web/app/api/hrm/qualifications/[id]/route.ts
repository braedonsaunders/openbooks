import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/src/platform/db.ts";
import {
  listQualificationEvents,
  loadQualification,
} from "@openbooks/engine/src/hrm/qualifications/qualifications.ts";
import { qualificationErrorResponse } from "../_lib";
/** One qualification with its evidence trail (drawer reads this). */
export const GET = defineRoute({
  permission: "hrm.certifications.read",
  feature: "hrmCertifications",
  params: z.object({ id: z.string() }),
  handler: async ({ request: _req, authz: gate, params }) => {
    try {
      const id = params.id;
      const qualification = await loadQualification(db, {
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        qualificationId: id,
      });
      if (!qualification) {
        return NextResponse.json(
          { error: "The qualification was not found in this organization." },
          { status: 404 },
        );
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
  },
});
