import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { authorizeService, serviceActor } from "@/lib/service/authority";
import { dispatchVisit } from "@openbooks/engine/service/dispatch";
import { deliverCustomerNotices } from "@openbooks/engine/service/notices";
import { dispatchVisitBody } from "@/lib/service/schemas";

export const runtime = "nodejs";

/** Dispatch a scheduled visit to its technicians. */
export const POST = defineRoute({
  authorize: authorizeService("service.dispatch"),
  feature: "serviceDispatch",
  body: dispatchVisitBody,
  handler: async ({ authz, body }) => {
    const actor = serviceActor(authz);
    const result = await dispatchVisit({ ...actor, ...body });
    const notices = result.notices.length
      ? await deliverCustomerNotices(actor, result.notices)
      : [];
    return NextResponse.json({ ...result, notices });
  },
});
