import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { authorizeService, serviceActor } from "@/lib/service/authority";
import { previewAssignment } from "@openbooks/engine/service/dispatch";
import { previewAssignmentBody } from "@/lib/service/schemas";

export const runtime = "nodejs";

/** The conflicts an assignment would meet (overlap, leave, qualifications, working hours), without writing. */
export const POST = defineRoute({
  authorize: authorizeService("service.dispatch"),
  feature: "serviceDispatch",
  body: previewAssignmentBody,
  handler: async ({ authz, body }) =>
    NextResponse.json({ conflicts: await previewAssignment({ ...serviceActor(authz), ...body }) }),
});
