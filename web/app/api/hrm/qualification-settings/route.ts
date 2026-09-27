import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@openbooks/engine/src/platform/db.ts";
import {
  loadSettings,
  setAlertSchedule,
} from "@openbooks/engine/src/hrm/qualifications/types.ts";
import { guardUnrestrictedScope } from "../../../../lib/authz";

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
export const GET = defineRoute({
  permission: "hrm.certifications.read",
  feature: "hrmCertifications",
  handler: async ({ authz: gate }) => {
    try {
      const settings = await loadSettings(db, gate.user.orgId);
      return NextResponse.json({ settings });
    } catch (e) {
      return qualificationErrorResponse(e);
    }
  },
});

export const POST = defineRoute({
  permission: "hrm.certifications.manage",
  feature: "hrmCertifications",
  body: setScheduleBody,
  handler: async ({ authz: gate, body: body }) => {
    const scopeDenied = guardUnrestrictedScope(gate);
    if (scopeDenied) return scopeDenied;

    try {
      const settings = await setAlertSchedule(db, {
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        ...body,
      });
      return NextResponse.json({ settings });
    } catch (e) {
      return qualificationErrorResponse(e);
    }
  },
});
