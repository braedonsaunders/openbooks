import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { authorizeService, serviceActor } from "@/lib/service/authority";
import { getServiceRequest } from "@openbooks/engine/service/reads";
import { updateServiceRequest } from "@openbooks/engine/service/requests";
import { idParams, updateRequestBody } from "@/lib/service/schemas";

export const runtime = "nodejs";

/** A service request with its visits and quotes; edits carry the revision they were made against. */
export const GET = defineRoute({
  authorize: authorizeService("service.read", "service.manage", "service.dispatch"),
  feature: "serviceDispatch",
  params: idParams,
  invalidParamsNotFound: "record",
  handler: async ({ authz, params }) =>
    NextResponse.json(await getServiceRequest({ ...serviceActor(authz), requestId: params.id })),
});

export const PATCH = defineRoute({
  authorize: authorizeService("service.manage"),
  feature: "serviceDispatch",
  params: idParams,
  invalidParamsNotFound: "record",
  body: updateRequestBody,
  handler: async ({ authz, params, body }) => {
    const { expectedRevision, ...input } = body;
    return NextResponse.json(
      await updateServiceRequest({
        ...serviceActor(authz),
        requestId: params.id,
        expectedRevision,
        input,
      }),
    );
  },
});
