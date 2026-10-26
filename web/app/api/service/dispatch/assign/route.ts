import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { authorizeService, serviceActor } from "@/lib/service/authority";
import { assignVisit } from "@openbooks/engine/service/dispatch";
import { deliverCustomerNotices } from "@openbooks/engine/service/notices";
import { assignBody } from "@/lib/service/schemas";

export const runtime = "nodejs";

/** Assign a visit to a technician at a time; overridable warnings need a reason, blocking conflicts refuse. */
export const POST = defineRoute({
  authorize: authorizeService("service.dispatch"),
  feature: "serviceDispatch",
  body: assignBody,
  handler: async ({ authz, body }) => {
    const actor = serviceActor(authz);
    const result = await assignVisit({ ...actor, ...body });
    const notices = result.notices.length
      ? await deliverCustomerNotices(actor, result.notices)
      : [];
    return NextResponse.json({ ...result, notices });
  },
});
