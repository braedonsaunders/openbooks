import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { authorizeService, serviceActor } from "@/lib/service/authority";
import { createServiceJob } from "@openbooks/engine/service/jobs";
import { createJobBody } from "@/lib/service/schemas";

export const runtime = "nodejs";

/** Create a service job directly or from a request; the client key makes a retry return the same job. */
export const POST = defineRoute({
  authorize: authorizeService("service.manage"),
  feature: "serviceDispatch",
  body: createJobBody,
  handler: async ({ authz, body }) => {
    const { id, ...input } = body;
    return NextResponse.json(await createServiceJob({ ...serviceActor(authz), id, input }), {
      status: 201,
    });
  },
});
