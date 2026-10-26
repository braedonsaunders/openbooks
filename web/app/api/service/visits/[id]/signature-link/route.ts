import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { authorizeService, serviceActor } from "@/lib/service/authority";
import {
  emailVisitSignatureLink,
  issueVisitSignatureLink,
} from "@openbooks/engine/service/signatures";
import { appBaseUrl } from "@/lib/service/delivery";
import { idParams, signatureLinkBody } from "@/lib/service/schemas";

export const runtime = "nodejs";

/** Issue the customer's sign-off link for a visit, optionally emailing it; the link opens on this device for in-person signing. */
export const POST = defineRoute({
  authorize: authorizeService("service.self", "service.manage", "service.dispatch"),
  feature: "serviceDispatch",
  params: idParams,
  invalidParamsNotFound: "record",
  body: signatureLinkBody,
  handler: async ({ authz, params, body, request }) => {
    const actor = serviceActor(authz);
    const issued = await issueVisitSignatureLink({
      ...actor,
      visitId: params.id,
      recipient: body.recipient ?? null,
    });
    const link = `${appBaseUrl(request)}/sign/service-visits/${issued.token}`;
    const email =
      body.email && issued.recipient
        ? await emailVisitSignatureLink({ ...actor, requestId: issued.requestId, link })
        : null;
    return NextResponse.json(
      {
        requestId: issued.requestId,
        expiresAt: issued.expiresAt,
        link,
        emailed: email?.sent ?? false,
        emailDetail: email?.detail ?? null,
      },
      { status: 201 },
    );
  },
});
