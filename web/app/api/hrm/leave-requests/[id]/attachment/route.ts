import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { recordLeaveAttachment } from "@openbooks/engine/src/hrm/leave.ts";

import { isUuid } from "../../../../../../lib/list-params";
import { leaveErrorResponse } from "../../_lib";
import { recordLeaveAttachmentBody } from "../../bodies";

export const runtime = "nodejs";

/** Record the attachment a requires_attachment type demands (draft only). */
export const POST = defineRoute({
  permission: "hrm.leave.request",
  feature: "hrm",
  params: z.object({ id: z.string().min(1) }),
  body: recordLeaveAttachmentBody,
  handler: async ({
    request: req,
    authz: gate,
    params: routeParams,
    body: body,
  }) => {
    const { id } = routeParams;
    if (!isUuid(id))
      return NextResponse.json(
        { error: "request id must be a uuid" },
        { status: 400 },
      );

    try {
      const request = await recordLeaveAttachment({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        requestId: id,
        attachmentId: body.attachmentId,
      });
      return NextResponse.json({ request });
    } catch (e) {
      return leaveErrorResponse(e);
    }
  },
});
