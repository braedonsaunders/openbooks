import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { authorizeService, serviceActor } from "@/lib/service/authority";
import { completeVisit } from "@openbooks/engine/service/completion";
import { idParams, visitCompleteBody } from "@/lib/service/schemas";

export const runtime = "nodejs";

/** Complete a visit on site: work notes, parts issued from stock, labor to timesheets, and any review Flow. */
export const POST = defineRoute({
  authorize: authorizeService("service.self", "service.manage", "service.dispatch"),
  feature: "serviceDispatch",
  params: idParams,
  invalidParamsNotFound: "record",
  body: visitCompleteBody,
  handler: async ({ authz, params, body }) =>
    NextResponse.json(await completeVisit({ ...serviceActor(authz), visitId: params.id, ...body })),
});
