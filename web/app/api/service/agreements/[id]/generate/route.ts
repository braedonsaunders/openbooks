import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { authorizeService, serviceActor } from "@/lib/service/authority";
import { generateAgreementVisits } from "@openbooks/engine/service/agreements";
import { idParams } from "@/lib/service/schemas";

export const runtime = "nodejs";

/** Generate the agreement's visits through the policy horizon now; generation is idempotent. */
export const POST = defineRoute({
  authorize: authorizeService("service.manage"),
  feature: "serviceDispatch",
  params: idParams,
  invalidParamsNotFound: "record",
  handler: async ({ authz, params }) =>
    NextResponse.json(
      await generateAgreementVisits({ ...serviceActor(authz), agreementId: params.id }),
    ),
});
