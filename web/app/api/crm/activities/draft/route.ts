import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { createCrmActivityDraft } from "@/lib/crm/actions";

const requestBodySchema = z
  .strictObject({
    kind: z.enum(["task", "call", "event", "email", "note"]).optional(),
    subjectId: uuidString().optional(),
    subjectKind: z.enum(["account", "contact", "opportunity", "document", "project"]).optional(),
  })
  .refine((body) => (body.subjectKind === undefined) === (body.subjectId === undefined), {
    message: "subjectKind and subjectId must be supplied together",
    path: ["subjectId"],
  });

export const runtime = "nodejs";

export const POST = defineRoute({
  permission: "crm.activities.manage",
  feature: "crm",
  body: requestBodySchema,
  handler: async ({ authz, body }) => {
    const result = await createCrmActivityDraft(authz, body);
    if ("response" in result) return result.response;
    return NextResponse.json(result.body, { status: result.status });
  },
});
