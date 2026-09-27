import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { NextResponse } from "next/server";
import {
  deleteProcessTemplateStep,
  upsertProcessTemplateStep,
} from "@openbooks/engine/src/hrm/processes.ts";
import { guardPermission } from "../../../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../../../lib/features";
import { isUuid } from "../../../../../../../lib/list-params";
import { processErrorResponse } from "../../../../processes/_lib";
import { saveProcessTemplateStepBody } from "../../../bodies";

export const runtime = "nodejs";

async function gate() {
  const result = await guardPermission("hrm.process.manage");
  if (result instanceof NextResponse) return result;
  if (!(await isFeatureEnabled(result.user.orgId, "hrm"))) {
    return notFound("record");
  }
  return result;
}

export const PATCH = defineRoute({
  public: "session",
  params: z.object({ id: z.string().min(1), stepId: z.string().min(1) }),
  body: saveProcessTemplateStepBody,
  handler: async ({ request: req, params: routeParams, body: body }) => {
    const authz = await gate();
    if (authz instanceof NextResponse) return authz;

    const ids = routeParams;
    if (!isUuid(ids.id) || !isUuid(ids.stepId)) {
      return NextResponse.json(
        { error: "template and step ids must be uuids" },
        { status: 400 },
      );
    }
    try {
      const step = await upsertProcessTemplateStep({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        templateId: ids.id,
        stepId: ids.stepId,
        ...body,
      });
      return NextResponse.json({ step });
    } catch (error) {
      return processErrorResponse(error);
    }
  },
});

export const DELETE = defineRoute({
  public: "session",
  params: z.object({ id: z.string().min(1), stepId: z.string().min(1) }),
  handler: async ({ request: _req, params: routeParams }) => {
    const authz = await gate();
    if (authz instanceof NextResponse) return authz;
    const ids = routeParams;
    if (!isUuid(ids.id) || !isUuid(ids.stepId)) {
      return NextResponse.json(
        { error: "template and step ids must be uuids" },
        { status: 400 },
      );
    }
    try {
      await deleteProcessTemplateStep({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        templateId: ids.id,
        stepId: ids.stepId,
      });
      return NextResponse.json({ ok: true });
    } catch (error) {
      return processErrorResponse(error);
    }
  },
});
