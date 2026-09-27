import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { NextResponse } from "next/server";
import {
  getProcessTemplate,
  updateProcessTemplate,
} from "@openbooks/engine/src/hrm/processes.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { isUuid } from "../../../../../lib/list-params";
import { processErrorResponse } from "../../processes/_lib";
import { updateProcessTemplateBody } from "../bodies";

export const runtime = "nodejs";

async function gate() {
  const result = await guardPermission("hrm.process.manage");
  if (result instanceof NextResponse) return result;
  if (!(await isFeatureEnabled(result.user.orgId, "hrm"))) {
    return notFound("record");
  }
  return result;
}

export const GET = defineRoute({
  public: "session",
  params: z.object({ id: z.string().min(1) }),
  handler: async ({ request: _req, params: routeParams }) => {
    const authz = await gate();
    if (authz instanceof NextResponse) return authz;
    const id = routeParams.id;
    if (!isUuid(id))
      return NextResponse.json(
        { error: "template id must be a uuid" },
        { status: 400 },
      );
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
  public: "session",
  params: z.object({ id: z.string().min(1) }),
  body: updateProcessTemplateBody,
  handler: async ({ params: routeParams, body: body }) => {
    const authz = await gate();
    if (authz instanceof NextResponse) return authz;

    const id = routeParams.id;
    if (!isUuid(id))
      return NextResponse.json(
        { error: "template id must be a uuid" },
        { status: 400 },
      );
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
