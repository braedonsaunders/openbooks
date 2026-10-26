import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { authorizeService, serviceActor } from "@/lib/service/authority";
import { invoiceServiceWork, previewServiceInvoice } from "@openbooks/engine/service/billing";
import { idParams, invoiceBody } from "@/lib/service/schemas";

export const runtime = "nodejs";

/** Preview or create the native draft invoice for a completed visit or job. */
export const GET = defineRoute({
  authorize: authorizeService("service.read", "service.manage", "service.dispatch"),
  feature: "serviceDispatch",
  params: idParams,
  invalidParamsNotFound: "record",
  handler: async ({ authz, params, request }) => {
    const visitId = new URL(request.url).searchParams.get("visit");
    return NextResponse.json(
      await previewServiceInvoice({ ...serviceActor(authz), jobId: params.id, visitId }),
    );
  },
});

export const POST = defineRoute({
  authorize: authorizeService("service.manage"),
  feature: "serviceDispatch",
  params: idParams,
  invalidParamsNotFound: "record",
  body: invoiceBody,
  handler: async ({ authz, params, body }) =>
    NextResponse.json(
      await invoiceServiceWork({
        ...serviceActor(authz),
        jobId: params.id,
        visitId: body.visitId ?? null,
      }),
      { status: 201 },
    ),
});
