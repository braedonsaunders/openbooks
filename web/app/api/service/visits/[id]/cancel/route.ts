import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { authorizeService, serviceActor } from "@/lib/service/authority";
import { cancelVisit } from "@openbooks/engine/service/visits";
import { idParams, visitCancelBody } from "@/lib/service/schemas";

export const runtime = "nodejs";

/** Cancel a visit (or skip an agreement occurrence); its bookings are released. */
export const POST = defineRoute({
  authorize: authorizeService("service.manage", "service.dispatch"),
  feature: "serviceDispatch",
  params: idParams,
  invalidParamsNotFound: "record",
  body: visitCancelBody,
  handler: async ({ authz, params, body }) =>
    NextResponse.json(await cancelVisit({ ...serviceActor(authz), visitId: params.id, ...body })),
});
