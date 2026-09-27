import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { correctEmploymentChange } from "@openbooks/engine/src/automations/event-verbs.ts";
import { HrmAuthorizationError } from "@openbooks/engine/src/hrm/authorization.ts";
import { hrmAuthorizationResponse } from "../../../../../../lib/api/record-not-found";
import { isUuid } from "../../../../../../lib/list-params";
import { automationErrorResponse } from "../../../../automations/_lib";
import { correctBody } from "../../../../automations/bodies";
/**
 * Correct a completed employment change. Default: opens a NEW pre-filled
 * change request (correct_requires_reapproval) — the correction still
 * passes approval. Direct application only when the org allows it.
 */
export const POST = defineRoute({
  permission: "hrm.employment.manage",
  feature: "hrmEventVerbs",
  body: correctBody,
  params: z.object({ id: z.string() }),
  handler: async ({ request: _req, authz: gate, params, body }) => {
    const { id } = params;
    if (!isUuid(id))
      return NextResponse.json(
        { error: "change id must be a uuid" },
        { status: 400 },
      );
    try {
      const result = await correctEmploymentChange({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        changeId: id,
        reason: body.reason,
        ...(body.correctedFields
          ? { correctedFields: body.correctedFields as Record<string, unknown> }
          : {}),
        ...(body.prefillPayload
          ? { prefillPayload: body.prefillPayload as Record<string, unknown> }
          : {}),
      });
      return NextResponse.json(result, { status: 201 });
    } catch (e) {
      // Employer-scope denials stay uniform not-visible, missing
      // grants stay named 403s — never the automations 500.
      if (e instanceof HrmAuthorizationError)
        return hrmAuthorizationResponse(e);
      return automationErrorResponse(e);
    }
  },
});
