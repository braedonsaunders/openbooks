import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { authorizeService, serviceActor } from "@/lib/service/authority";
import { addAssessmentVisit } from "@openbooks/engine/service/requests";
import { assessmentBody, idParams } from "@/lib/service/schemas";

export const runtime = "nodejs";

/** Add an assessment visit to a request; it waits unscheduled in the dispatch queue. */
export const POST = defineRoute({
  authorize: authorizeService("service.manage"),
  feature: "serviceDispatch",
  params: idParams,
  invalidParamsNotFound: "record",
  body: assessmentBody,
  handler: async ({ authz, params, body }) =>
    NextResponse.json(
      await addAssessmentVisit({ ...serviceActor(authz), requestId: params.id, ...body }),
      { status: 201 },
    ),
});
