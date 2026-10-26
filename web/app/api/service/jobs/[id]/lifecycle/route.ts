import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { authorizeService, serviceActor } from "@/lib/service/authority";
import {
  cancelServiceJob,
  completeServiceJob,
  reopenServiceJob,
} from "@openbooks/engine/service/jobs";
import { idParams, jobLifecycleBody } from "@/lib/service/schemas";

export const runtime = "nodejs";

/** Complete, reopen or cancel a job. */
export const POST = defineRoute({
  authorize: authorizeService("service.manage"),
  feature: "serviceDispatch",
  params: idParams,
  invalidParamsNotFound: "record",
  body: jobLifecycleBody,
  handler: async ({ authz, params, body }) => {
    const actor = {
      ...serviceActor(authz),
      jobId: params.id,
      expectedRevision: body.expectedRevision,
    };
    const job =
      body.action === "complete"
        ? await completeServiceJob(actor)
        : body.action === "reopen"
          ? await reopenServiceJob({ ...actor, reason: body.reason })
          : await cancelServiceJob({ ...actor, reason: body.reason });
    return NextResponse.json(job);
  },
});
