import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  getProcessTemplate,
  updateProcessTemplate,
} from "@openbooks/engine/hrm/processes/operations";
import { isUuid } from "@/lib/list-params";
import { processErrorResponse } from "../../processes/_lib";
import { updateProcessTemplateBody } from "../bodies";

export const runtime = "nodejs";

export const GET = defineRoute({
  permission: "hrm.process.manage",
  feature: "hrm",
  params: z.object({ id: z.string().min(1) }),
  handler: async ({ params: routeParams, authz }) => {
    const id = routeParams.id;
    if (!isUuid(id))
      return NextResponse.json({ error: "template id must be a uuid" }, { status: 400 });
    try {
      const template = await getProcessTemplate({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        templateId: id,
      });
      return NextResponse.json({ template });
    } catch (error) {
      return processErrorResponse(error);
    }
  },
});

export const PATCH = defineRoute({
  permission: "hrm.process.manage",
  feature: "hrm",
  params: z.object({ id: z.string().min(1) }),
  body: updateProcessTemplateBody,
  handler: async ({ params: routeParams, authz, body: body }) => {
    const id = routeParams.id;
    if (!isUuid(id))
      return NextResponse.json({ error: "template id must be a uuid" }, { status: 400 });
    try {
      const template = await updateProcessTemplate({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        templateId: id,
        ...body,
      });
      return NextResponse.json({ template });
    } catch (error) {
      return processErrorResponse(error);
    }
  },
});
