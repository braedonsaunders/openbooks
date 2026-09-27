import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { closeEnrollmentWindow } from "@openbooks/engine/src/hrm/benefits/windows.ts";
import { isUuid } from "../../../../../../lib/list-params";
import { benefitsErrorResponse } from "../../../benefits/_lib";
import { closeWindowBody } from "../../bodies";
/**
 * Close an open window. The reason is required: it is recorded on every
 * pending election the closure refuses, so no election is silently dropped.
 */
export const POST = defineRoute({
  permission: "hrm.benefits.manage",
  feature: "hrm",
  body: closeWindowBody,
  params: z.object({ id: z.string() }),
  handler: async ({ request: req, authz: gate, params, body }) => {
    const { id } = params;
    if (!isUuid(id))
      return NextResponse.json(
        { error: "window id must be a uuid" },
        { status: 400 },
      );
    try {
      const window = await closeEnrollmentWindow({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        windowId: id,
        reason: body.reason,
      });
      return NextResponse.json({ window });
    } catch (e) {
      return benefitsErrorResponse(e);
    }
  },
});
