import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { authorizeService, serviceActor } from "@/lib/service/authority";
import { createServiceAgreement } from "@openbooks/engine/service/agreements";
import { createAgreementBody } from "@/lib/service/schemas";

export const runtime = "nodejs";

/** Create a recurring service agreement and generate its visits through the policy horizon. */
export const POST = defineRoute({
  authorize: authorizeService("service.manage"),
  feature: "serviceDispatch",
  body: createAgreementBody,
  handler: async ({ authz, body }) => {
    const { id, ...input } = body;
    return NextResponse.json(await createServiceAgreement({ ...serviceActor(authz), id, input }), {
      status: 201,
    });
  },
});
