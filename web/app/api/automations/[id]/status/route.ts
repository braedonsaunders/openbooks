import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { setAutomationStatus } from "@openbooks/engine/src/automations/services.ts";
import { isUuid } from "../../../../../lib/list-params";
import { automationStatusBody } from "../../bodies";
import { automationErrorResponse } from "../../_lib";
import { notFound } from "@/lib/api/responses";


export { runtime } from "@/lib/api/route";

/** Enable/disable an automation (enabling re-validates the recipe). */
export const POST = defineRoute({
  permission: "automations.manage",
  feature: "automations",
  params: z.object({ id: z.string() }),
  body: automationStatusBody,
  handler: async ({ request: req, authz: gate, params, body: routeBody }) => {
    const ctx = { params };

    const { id } = await ctx.params;
    if (!isUuid(id))
      return NextResponse.json(
        { error: "automation id must be a uuid" },
        { status: 400 },
      );

    try {
      const automation = await setAutomationStatus({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        automationId: id,
        status: routeBody.status,
      });
      return NextResponse.json({ automation });
    } catch (e) {
      return automationErrorResponse(e);
    }
  },
});
