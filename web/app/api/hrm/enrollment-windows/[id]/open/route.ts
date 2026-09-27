import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { openEnrollmentWindow } from "@openbooks/engine/src/hrm/benefits/windows.ts";
import { isUuid } from "../../../../../../lib/list-params";
import { benefitsErrorResponse } from "../../../benefits/_lib";
import { emptyBody } from "../../bodies";
/** Open a draft window (overlap and inverted-range refusals name the remedy). */
export const POST = defineRoute({
  permission: "hrm.benefits.manage",
  feature: "hrm",
  body: emptyBody,
  params: z.object({ id: z.string() }),
  handler: async ({ request: _req, authz: gate, params }) => {
    const { id } = params;
    if (!isUuid(id))
      return NextResponse.json(
        { error: "window id must be a uuid" },
        { status: 400 },
      );
    try {
      const window = await openEnrollmentWindow({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        windowId: id,
      });
      return NextResponse.json({ window });
    } catch (e) {
      return benefitsErrorResponse(e);
    }
  },
});
