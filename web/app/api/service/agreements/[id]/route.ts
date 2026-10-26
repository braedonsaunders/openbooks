import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { authorizeService, serviceActor } from "@/lib/service/authority";
import { getServiceAgreement } from "@openbooks/engine/service/reads";
import { idParams } from "@/lib/service/schemas";

export const runtime = "nodejs";

/** A service agreement with its effective-dated versions and generated visits. */
export const GET = defineRoute({
  authorize: authorizeService("service.read", "service.manage", "service.dispatch"),
  feature: "serviceDispatch",
  params: idParams,
  invalidParamsNotFound: "record",
  handler: async ({ authz, params }) =>
    NextResponse.json(
      await getServiceAgreement({ ...serviceActor(authz), agreementId: params.id }),
    ),
});
