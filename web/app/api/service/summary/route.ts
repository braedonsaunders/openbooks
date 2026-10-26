import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { authorizeService, serviceActor } from "@/lib/service/authority";
import { serviceHomeSummary } from "@openbooks/engine/service/reads";

export const runtime = "nodejs";

/** The counts the service home shows, within the caller's legal entities. */
export const GET = defineRoute({
  authorize: authorizeService("service.read", "service.manage", "service.dispatch"),
  feature: "serviceDispatch",
  handler: async ({ authz }) => NextResponse.json(await serviceHomeSummary(serviceActor(authz))),
});
