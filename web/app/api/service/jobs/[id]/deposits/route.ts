import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { authorizeService, serviceActor } from "@/lib/service/authority";
import { recordServiceDeposit, serviceDepositCandidates } from "@openbooks/engine/service/billing";
import { depositBody, idParams } from "@/lib/service/schemas";

export const runtime = "nodejs";

/** The customer's payments held on account, and recording one as the job's deposit. */
export const GET = defineRoute({
  authorize: authorizeService("service.manage"),
  feature: "serviceDispatch",
  params: idParams,
  invalidParamsNotFound: "record",
  handler: async ({ authz, params }) =>
    NextResponse.json({
      candidates: await serviceDepositCandidates({ ...serviceActor(authz), jobId: params.id }),
    }),
});

export const POST = defineRoute({
  authorize: authorizeService("service.manage"),
  feature: "serviceDispatch",
  params: idParams,
  invalidParamsNotFound: "record",
  body: depositBody,
  handler: async ({ authz, params, body }) =>
    NextResponse.json(
      await recordServiceDeposit({
        ...serviceActor(authz),
        jobId: params.id,
        paymentDocumentId: body.paymentDocumentId,
      }),
      { status: 201 },
    ),
});
