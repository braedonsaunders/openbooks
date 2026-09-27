import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  compensationSettingsDocument,
  updateCompensationSettings,
} from "@openbooks/engine/src/hrm/compensation/architecture.ts";
import { compensationErrorResponse } from "../compensation/_lib";
import { COMPENSATION_PERCENTAGE_INPUTS } from "../compensation/percentage-inputs";
/**
 * Compensation settings (the orgs.settings compensation document):
 * comparison attribute key, unexplained-gap threshold, pay-information
 * response days, FTE rounding, and the declared burden rate. GET reads
 * through comp.read; PUT writes through comp.manage with every field
 * validated before the document commits. Gated on hrmCompensation.
 * The client checks res.ok before parsing.
 *
 * The document is org-wide policy with no subsidiary lineage — one write
 * re-tunes every entity's gap analysis and burdened costing at once — so
 * PUT needs unrestricted subsidiary scope (canonical shape 2): restricted
 * callers get the named 403 and store nothing. GET stays open to every
 * comp.read holder: the five fields are policy scalars that disclose no
 * per-subsidiary material, and restricted analysts need them to run their
 * own entity's comparisons.
 */
const settingsBody = z.object({
  comparisonAttributeKey: z.string().trim().max(120).nullable().optional(),
  gapThresholdPct: COMPENSATION_PERCENTAGE_INPUTS.gapThresholdPct
    .nullable()
    .optional(),
  responseDays: z.number().int().positive().nullable().optional(),
  fteRounding: z
    .enum(["up_to_whole", "nearest_tenth", "nearest_hundredth"])
    .nullable()
    .optional(),
  burdenRate: z
    .string()
    .regex(/^\d+(\.\d+)?$/)
    .nullable()
    .optional(),
});
export const GET = defineRoute({
  permission: "hrm.compensation.read",
  feature: "hrmCompensation",
  handler: async ({ authz: gate }) => {
    const compensation = await compensationSettingsDocument(gate.user.orgId);
    return NextResponse.json({ settings: compensation });
  },
});
export const PUT = defineRoute({
  permission: "hrm.compensation.manage",
  feature: "hrmCompensation",
  scope: "unrestricted",
  body: settingsBody,
  handler: async ({ request: _req, authz: gate, body }) => {
    try {
      const next = await updateCompensationSettings({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        ...body,
      });
      return NextResponse.json({ settings: next });
    } catch (e) {
      return compensationErrorResponse(e);
    }
  },
});
