import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  deleteProcessTemplateStep,
  upsertProcessTemplateStep,
} from "@openbooks/engine/hrm/processes/operations";
import { isUuid } from "@/lib/list-params";
import { processErrorResponse } from "../../../../processes/_lib";
import { saveProcessTemplateStepBody } from "../../../bodies";

export const runtime = "nodejs";

export const PATCH = defineRoute({
  permission: "hrm.process.manage",
  feature: "hrm",
  params: z.object({ id: z.string().min(1), stepId: z.string().min(1) }),
  body: saveProcessTemplateStepBody,
  handler: async ({ params: routeParams, authz, body: body }) => {
    const ids = routeParams;
    if (!isUuid(ids.id) || !isUuid(ids.stepId)) {
      return NextResponse.json({ error: "template and step ids must be uuids" }, { status: 400 });
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
  permission: "hrm.process.manage",
  feature: "hrm",
  params: z.object({ id: z.string().min(1), stepId: z.string().min(1) }),
  handler: async ({ params: routeParams, authz }) => {
    const ids = routeParams;
    if (!isUuid(ids.id) || !isUuid(ids.stepId)) {
      return NextResponse.json({ error: "template and step ids must be uuids" }, { status: 400 });
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
