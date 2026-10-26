import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { authorizeService, serviceActor } from "@/lib/service/authority";
import { closeServiceAgreement } from "@openbooks/engine/service/agreements";
import { closeAgreementBody, idParams } from "@/lib/service/schemas";

export const runtime = "nodejs";

/** End or cancel an agreement; unbooked future visits are released. */
export const POST = defineRoute({
  authorize: authorizeService("service.manage"),
  feature: "serviceDispatch",
  params: idParams,
  invalidParamsNotFound: "record",
  body: closeAgreementBody,
  handler: async ({ authz, params, body }) =>
    NextResponse.json(
      await closeServiceAgreement({ ...serviceActor(authz), agreementId: params.id, ...body }),
    ),
});
