import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { authorizeService, serviceActor } from "@/lib/service/authority";
import { unassignVisitBooking } from "@openbooks/engine/service/dispatch";
import { unassignBody } from "@/lib/service/schemas";

export const runtime = "nodejs";

/** Return a visit booking to the unscheduled queue. */
export const POST = defineRoute({
  authorize: authorizeService("service.dispatch"),
  feature: "serviceDispatch",
  body: unassignBody,
  handler: async ({ authz, body }) =>
    NextResponse.json(await unassignVisitBooking({ ...serviceActor(authz), ...body })),
});
