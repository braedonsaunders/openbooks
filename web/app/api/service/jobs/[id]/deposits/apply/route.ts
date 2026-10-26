import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { authorizeService, serviceActor } from "@/lib/service/authority";
import { applyServiceDeposits } from "@openbooks/engine/service/billing";
import { applyDepositsBody, idParams } from "@/lib/service/schemas";

export const runtime = "nodejs";

/** Apply the job's deposits to one of its posted invoices as native credit settlements. */
export const POST = defineRoute({
  authorize: authorizeService("service.manage"),
  feature: "serviceDispatch",
  params: idParams,
  invalidParamsNotFound: "record",
  body: applyDepositsBody,
  handler: async ({ authz, params, body }) =>
    NextResponse.json(
      await applyServiceDeposits({
        ...serviceActor(authz),
        jobId: params.id,
        invoiceDocumentId: body.invoiceDocumentId,
      }),
    ),
});
