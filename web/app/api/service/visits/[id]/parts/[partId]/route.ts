import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { authorizeService, serviceActor } from "@/lib/service/authority";
import { removeVisitPart } from "@openbooks/engine/service/completion";
import { visitPartParams, visitPartRemoveBody } from "@/lib/service/schemas";

export const runtime = "nodejs";

/** Remove a part recorded on an active visit before it issues. */
export const DELETE = defineRoute({
  authorize: authorizeService("service.self", "service.manage", "service.dispatch"),
  feature: "serviceDispatch",
  params: visitPartParams,
  invalidParamsNotFound: "record",
  body: visitPartRemoveBody,
  handler: async ({ authz, params, body }) =>
    NextResponse.json(
      await removeVisitPart({
        ...serviceActor(authz),
        visitId: params.id,
        partId: params.partId,
        expectedRevision: body.expectedRevision,
      }),
    ),
});
