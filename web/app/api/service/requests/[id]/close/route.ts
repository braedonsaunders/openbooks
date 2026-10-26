import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { authorizeService, serviceActor } from "@/lib/service/authority";
import { closeServiceRequest } from "@openbooks/engine/service/requests";
import { closeRequestBody, idParams } from "@/lib/service/schemas";

export const runtime = "nodejs";

/** Decline or cancel an open request, with the reason. */
export const POST = defineRoute({
  authorize: authorizeService("service.manage"),
  feature: "serviceDispatch",
  params: idParams,
  invalidParamsNotFound: "record",
  body: closeRequestBody,
  handler: async ({ authz, params, body }) =>
    NextResponse.json(
      await closeServiceRequest({ ...serviceActor(authz), requestId: params.id, ...body }),
    ),
});
