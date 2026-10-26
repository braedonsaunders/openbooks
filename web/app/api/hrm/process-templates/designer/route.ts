import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { NextResponse } from "next/server";
import { checklistDocumentSchema } from "@openbooks/forms-core";
import {
  getChecklistDesigner,
  getChecklistVersion,
  saveChecklistDraft,
  retireChecklistTemplate,
  publishChecklistDraft,
  previewChecklistCoverage,
} from "@openbooks/engine/hrm/processes";
import { civilDateInput } from "@/lib/api/civil-date";
import { defineRoute } from "@/lib/api/route";
import { processErrorResponse } from "../../processes/_lib";

export const runtime = "nodejs";
const identity = { templateId: uuidString(), revision: z.number().int().nonnegative() };
const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("load"), templateId: uuidString() }),
  z.object({
    action: z.literal("version"),
    templateId: uuidString(),
    version: z.number().int().positive(),
  }),
  z.object({ action: z.literal("save"), ...identity, document: checklistDocumentSchema }),
  z.object({
    action: z.literal("retire"),
    ...identity,
    reason: z.string().trim().min(1).max(2000),
  }),
  z.object({
    action: z.literal("publish"),
    ...identity,
    reason: z.string().trim().min(1).max(2000),
  }),
  z.object({
    action: z.literal("preview"),
    employmentId: uuidString(),
    effectiveDate: civilDateInput(),
    document: checklistDocumentSchema,
  }),
]);
export const POST = defineRoute({
  permission: "hrm.process.manage",
  feature: "hrm",
  body: bodySchema,
  invalidBodyStatus: 400,
  handler: async ({ authz, body }) => {
    const context = { orgId: authz.user.orgId, actorId: authz.user.id };
    try {
      const result =
        body.action === "save"
          ? await saveChecklistDraft({ ...context, ...body })
          : body.action === "retire"
            ? await retireChecklistTemplate({ ...context, ...body })
            : body.action === "publish"
              ? await publishChecklistDraft({ ...context, ...body })
              : body.action === "load"
                ? await getChecklistDesigner({ ...context, ...body })
                : body.action === "version"
                  ? await getChecklistVersion({ ...context, ...body })
                  : await previewChecklistCoverage({ ...context, ...body });
      return NextResponse.json(result);
    } catch (error) {
      return processErrorResponse(error);
    }
  },
});
