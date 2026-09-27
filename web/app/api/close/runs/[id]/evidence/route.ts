import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from '@/lib/api/error-response'
import { guardCloseScope } from "@/lib/close-scope";

import { NextResponse } from "next/server";
import { addCloseEvidence } from "@openbooks/engine/src/close/tasks.ts";
import { CloseError } from "@openbooks/engine/src/periods/period-policy.ts";

import { isUuid } from "../../../../../../lib/list-params";

const requestBodySchema = z.object({
  evidenceType: z.enum(["file", "report", "journal", "reconciliation", "link", "note"]),
  taskId: z.string().uuid(),
  label: z.string().trim().min(1).max(200),
  fileId: z.string().uuid().optional(),
  referenceId: z.string().uuid().optional(),
  referenceUrl: z.string().url().optional(),
  snapshot: z.record(z.string(), z.json()).optional(),
});


export const runtime = "nodejs";

const EVIDENCE_TYPES = new Set([
  "file",
  "report",
  "journal",
  "reconciliation",
  "link",
  "note",
]);



export const POST = defineRoute({
  permission: "close.run",
  feature: "continuousClose",
  params: z.object({ "id": z.string() }),
  body: requestBodySchema,
  handler: async ({ body, params, authz: routeAuthz }) => {

    const { id } = params;
    const gate = routeAuthz;

    const scopeDenied = guardCloseScope(gate);
    if (scopeDenied) return scopeDenied;



    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    const evidenceType =
      typeof body.evidenceType === "string" ? body.evidenceType : "";
    const label = typeof body.label === "string" ? body.label.trim() : "";
    if (
      !isUuid(id) ||
      !isUuid(taskId) ||
      !EVIDENCE_TYPES.has(evidenceType) ||
      !label
    ) {
      return NextResponse.json(
        { error: "valid task, evidence type, and label are required" },
        { status: 400 },
      );
    }
    try {
      const evidenceId = await addCloseEvidence({
        orgId: gate.user.orgId,
        runId: id,
        taskId,
        actorId: gate.user.id,
        evidenceType: evidenceType as Parameters<
          typeof addCloseEvidence
        >[0]["evidenceType"],
        label,
        fileId:
          typeof body.fileId === "string" && isUuid(body.fileId)
            ? body.fileId
            : undefined,
        referenceId:
          typeof body.referenceId === "string" && isUuid(body.referenceId)
            ? body.referenceId
            : undefined,
        referenceUrl:
          typeof body.referenceUrl === "string" ? body.referenceUrl : undefined,
        snapshot:
          body.snapshot &&
          typeof body.snapshot === "object" &&
          !Array.isArray(body.snapshot)
            ? (body.snapshot as Record<string, unknown>)
            : undefined,
      });
      return NextResponse.json({ ok: true, evidenceId });
    } catch (error) {
      if (error instanceof CloseError)
        return apiErrorResponse(error, { safeStatus: 422 });
      throw error;
    }
  },
});
