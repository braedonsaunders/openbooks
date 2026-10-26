import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { authorizeService, serviceActor } from "@/lib/service/authority";
import { deliverCustomerNotices } from "@openbooks/engine/service/notices";
import { setVisitFieldStatus } from "@openbooks/engine/service/visits";
import { idParams, visitStatusBody } from "@/lib/service/schemas";

export const runtime = "nodejs";

/** Move a visit to a field status; an en-route move sends the customer's opted-in notice after commit. */
export const POST = defineRoute({
  authorize: authorizeService("service.self", "service.manage", "service.dispatch"),
  feature: "serviceDispatch",
  params: idParams,
  invalidParamsNotFound: "record",
  body: visitStatusBody,
  handler: async ({ authz, params, body }) => {
    const actor = serviceActor(authz);
    const result = await setVisitFieldStatus({ ...actor, visitId: params.id, ...body });
    const notices = result.notices.length
      ? await deliverCustomerNotices(actor, result.notices)
      : [];
    return NextResponse.json({ ...result, notices });
  },
});
