import { z } from "zod";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { civilDateInput } from "@/lib/api/civil-date";
import { serviceActor } from "@/lib/service/authority";
import { listPolicies, savePolicyVersion } from "@openbooks/engine/service/policy";

export const runtime = "nodejs";

// A blank optional target arrives as an empty string from the setup form: no target for that priority.
const optionalHours = z
  .union([z.number().int(), z.literal("")])
  .nullable()
  .optional()
  .transform((value) => (value === "" || value === undefined ? null : value));
const policyBody = z.strictObject({
  effectiveFrom: civilDateInput(),
  notifyArrivalWindow: z.boolean(),
  notifyEnRoute: z.boolean(),
  arrivalWindowMinutes: z.number().int(),
  defaultVisitMinutes: z.number().int(),
  urgentResponseHours: optionalHours,
  highResponseHours: optionalHours,
  normalResponseHours: optionalHours,
  lowResponseHours: optionalHours,
  agreementHorizonDays: z.number().int(),
  reason: z.string().trim().min(1).max(2000),
});

/** The dispatch policy versions, newest effective date first. */
export const GET = defineRoute({
  permission: "admin.setup.manage",
  feature: "serviceDispatch",
  scope: "unrestricted",
  handler: async ({ authz }) =>
    NextResponse.json({ policies: await listPolicies(authz.user.orgId) }),
});

/**
 * Append a dispatch policy version effective from its date. Organization-wide
 * configuration: the engine requires Setup management across every legal entity.
 */
export const POST = defineRoute({
  permission: "admin.setup.manage",
  feature: "serviceDispatch",
  scope: "unrestricted",
  body: policyBody,
  handler: async ({ authz, body }) => {
    const policy = await savePolicyVersion({
      ...serviceActor(authz),
      input: {
        ...body,
      },
    });
    return NextResponse.json(policy, { status: 201 });
  },
});
