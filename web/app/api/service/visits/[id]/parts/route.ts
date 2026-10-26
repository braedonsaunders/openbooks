import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { authorizeService, serviceActor } from "@/lib/service/authority";
import { recordPricedVisitPart } from "@/lib/service/parts";
import { idParams, visitPartBody } from "@/lib/service/schemas";

export const runtime = "nodejs";

/** Record a part used on a visit; it issues from stock when the visit completes. */
export const POST = defineRoute({
  authorize: authorizeService("service.self", "service.manage", "service.dispatch"),
  feature: "serviceDispatch",
  params: idParams,
  invalidParamsNotFound: "record",
  body: visitPartBody,
  handler: async ({ authz, params, body }) => {
    const { expectedRevision, ...part } = body;
    return NextResponse.json(
      await recordPricedVisitPart(serviceActor(authz), {
        visitId: params.id,
        expectedRevision,
        part,
      }),
      { status: 201 },
    );
  },
});
