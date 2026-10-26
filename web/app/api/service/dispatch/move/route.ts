import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { authorizeService, serviceActor } from "@/lib/service/authority";
import { moveVisitBooking } from "@openbooks/engine/service/dispatch";
import { deliverCustomerNotices } from "@openbooks/engine/service/notices";
import { moveBody } from "@/lib/service/schemas";

export const runtime = "nodejs";

/** Move or reassign a visit booking with the same conflict checks. */
export const POST = defineRoute({
  authorize: authorizeService("service.dispatch"),
  feature: "serviceDispatch",
  body: moveBody,
  handler: async ({ authz, body }) => {
    const actor = serviceActor(authz);
    const result = await moveVisitBooking({ ...actor, ...body });
    const notices = result.notices.length
      ? await deliverCustomerNotices(actor, result.notices)
      : [];
    return NextResponse.json({ ...result, notices });
  },
});
