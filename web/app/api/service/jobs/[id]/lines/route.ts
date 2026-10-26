import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { authorizeService, serviceActor } from "@/lib/service/authority";
import { replaceJobLines } from "@openbooks/engine/service/jobs";
import { idParams, jobLinesBody } from "@/lib/service/schemas";

export const runtime = "nodejs";

/** Replace an open job's scope lines. */
export const PUT = defineRoute({
  authorize: authorizeService("service.manage"),
  feature: "serviceDispatch",
  params: idParams,
  invalidParamsNotFound: "record",
  body: jobLinesBody,
  handler: async ({ authz, params, body }) =>
    NextResponse.json(await replaceJobLines({ ...serviceActor(authz), jobId: params.id, ...body })),
});
