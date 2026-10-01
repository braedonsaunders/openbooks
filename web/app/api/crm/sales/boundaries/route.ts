import { NextResponse } from "next/server";
import { getAuthz, can, guardPermission } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { SalesError } from "@openbooks/engine/crm/sales";
import {
  salesBoundaries,
  salesCountries,
} from "@/lib/crm/territory-boundaries";
export const runtime = "nodejs";
export const GET = defineRoute({
  authorize: async () => {
    const authz = await getAuthz();
    return authz &&
      (can(authz, "crm.setup.manage") || can(authz, "crm.forecasts.read"))
      ? authz
      : guardPermission("crm.forecasts.read");
  },
  feature: "geographicTerritories",
  handler: async ({ request }) => {
    const params = new URL(request.url).searchParams;
    if (params.get("countries") === "true")
      return NextResponse.json(await salesCountries());
    const level = params.get("level") ?? "ADM1";
    if (!["ADM0", "ADM1", "ADM2"].includes(level))
      throw new SalesError(
        "Choose country, province/state, or county/district boundaries.",
      );
    return NextResponse.json(
      await salesBoundaries(
        params.get("country") ?? "CAN",
        level as "ADM0" | "ADM1" | "ADM2",
      ),
    );
  },
});
