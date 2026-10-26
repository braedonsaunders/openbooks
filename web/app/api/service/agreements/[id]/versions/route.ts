import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { authorizeService, serviceActor } from "@/lib/service/authority";
import { addAgreementVersion } from "@openbooks/engine/service/agreements";
import { agreementVersionBody, idParams } from "@/lib/service/schemas";

export const runtime = "nodejs";

/** Add an agreement version effective from a date; earlier occurrences keep the terms they were generated under. */
export const POST = defineRoute({
  authorize: authorizeService("service.manage"),
  feature: "serviceDispatch",
  params: idParams,
  invalidParamsNotFound: "record",
  body: agreementVersionBody,
  handler: async ({ authz, params, body }) =>
    NextResponse.json(
      await addAgreementVersion({ ...serviceActor(authz), agreementId: params.id, ...body }),
      { status: 201 },
    ),
});
