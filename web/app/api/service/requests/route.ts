import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { authorizeService, serviceActor } from "@/lib/service/authority";
import { createServiceRequest } from "@openbooks/engine/service/requests";
import { createRequestBody } from "@/lib/service/schemas";

export const runtime = "nodejs";

/** Take a service request; the client key makes a retried submission return the same request. */
export const POST = defineRoute({
  authorize: authorizeService("service.manage"),
  feature: "serviceDispatch",
  body: createRequestBody,
  handler: async ({ authz, body }) => {
    const { id, ...input } = body;
    return NextResponse.json(await createServiceRequest({ ...serviceActor(authz), id, input }), {
      status: 201,
    });
  },
});
