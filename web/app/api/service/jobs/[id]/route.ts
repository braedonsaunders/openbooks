import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { authorizeService, serviceActor } from "@/lib/service/authority";
import { getServiceJob } from "@openbooks/engine/service/reads";
import { updateServiceJob } from "@openbooks/engine/service/jobs";
import { idParams, updateJobBody } from "@/lib/service/schemas";

export const runtime = "nodejs";

/** A service job with its scope, visits, deposits and invoices. */
export const GET = defineRoute({
  authorize: authorizeService("service.read", "service.manage", "service.dispatch"),
  feature: "serviceDispatch",
  params: idParams,
  invalidParamsNotFound: "record",
  handler: async ({ authz, params }) =>
    NextResponse.json(await getServiceJob({ ...serviceActor(authz), jobId: params.id })),
});

export const PATCH = defineRoute({
  authorize: authorizeService("service.manage"),
  feature: "serviceDispatch",
  params: idParams,
  invalidParamsNotFound: "record",
  body: updateJobBody,
  handler: async ({ authz, params, body }) => {
    const { expectedRevision, ...input } = body;
    return NextResponse.json(
      await updateServiceJob({ ...serviceActor(authz), jobId: params.id, expectedRevision, input }),
    );
  },
});
