import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { authorizeService, serviceActor } from "@/lib/service/authority";
import { addJobVisit } from "@openbooks/engine/service/jobs";
import { idParams, jobVisitBody } from "@/lib/service/schemas";

export const runtime = "nodejs";

/** Add a visit to an open job; it waits unscheduled in the dispatch queue. */
export const POST = defineRoute({
  authorize: authorizeService("service.manage"),
  feature: "serviceDispatch",
  params: idParams,
  invalidParamsNotFound: "record",
  body: jobVisitBody,
  handler: async ({ authz, params, body }) =>
    NextResponse.json(await addJobVisit({ ...serviceActor(authz), jobId: params.id, ...body }), {
      status: 201,
    }),
});
