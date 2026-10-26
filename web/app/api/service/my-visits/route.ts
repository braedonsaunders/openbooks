import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { authorizeService, serviceActor } from "@/lib/service/authority";
import { listMyVisits } from "@openbooks/engine/service/reads";
import { myVisitsQuery } from "@/lib/service/schemas";

export const runtime = "nodejs";

/** The signed-in technician's own visits in a date range, in booking order. */
export const GET = defineRoute({
  authorize: authorizeService("service.self"),
  feature: "serviceDispatch",
  handler: async ({ authz, request }) => {
    const search = new URL(request.url).searchParams;
    const parsed = myVisitsQuery.safeParse({
      from: search.get("from"),
      through: search.get("through"),
    });
    if (!parsed.success)
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Choose a date range." },
        { status: 400 },
      );
    return NextResponse.json(await listMyVisits({ ...serviceActor(authz), ...parsed.data }));
  },
});
