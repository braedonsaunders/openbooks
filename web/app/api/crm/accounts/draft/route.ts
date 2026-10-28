import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createCrmAccountDraft } from "@/lib/crm/actions";

export const runtime = "nodejs";

const DRAFT_STAGES = ["lead", "prospect"] as const;

const draftBody = z.strictObject({
  lifecycleStage: z
    .enum(DRAFT_STAGES, {
      error: `lifecycleStage must be one of ${DRAFT_STAGES.join(", ")}`,
    })
    .optional(),
});

export const POST = defineRoute({
  permission: "crm.accounts.create",
  feature: "crm",
  body: draftBody,
  invalidBodyStatus: 422,
  handler: async ({ authz, body }) => {
    const result = await createCrmAccountDraft(authz, body.lifecycleStage ?? "lead");
    if ("response" in result) return result.response;
    return NextResponse.json(result.body, { status: result.status });
  },
});
