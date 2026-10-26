import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { authorizeService, canAny, SERVICE_STAFF_PERMISSIONS } from "@/lib/service/authority";
import {
  customerOptions,
  customerSites,
  itemOptions,
  qualificationOptions,
} from "@/lib/service/options";
import { servicePartItems, serviceStockLocations } from "@/lib/service/parts";
import { isUuid } from "@/lib/list-params";

export const runtime = "nodejs";

/**
 * Pickers for service forms. Technicians read only what recording a part
 * needs (items and stock locations); customers, sites, qualifications and
 * priced items are for service staff.
 */
export const GET = defineRoute({
  authorize: authorizeService("service.read", "service.manage", "service.dispatch", "service.self"),
  feature: "serviceDispatch",
  handler: async ({ authz, request }) => {
    const search = new URL(request.url).searchParams;
    const kind = search.get("kind");
    const query = (search.get("q") ?? "").slice(0, 100);
    const orgId = authz.user.orgId;
    if (kind === "part-items")
      return NextResponse.json({ options: await servicePartItems(orgId, query) });
    if (kind === "stock-locations")
      return NextResponse.json({ options: await serviceStockLocations(authz) });
    if (!canAny(authz, SERVICE_STAFF_PERMISSIONS))
      return NextResponse.json({ error: "missing permission: service.read" }, { status: 403 });
    if (kind === "customers")
      return NextResponse.json({ options: await customerOptions(authz, query) });
    if (kind === "items") return NextResponse.json({ options: await itemOptions(orgId, query) });
    if (kind === "qualifications")
      return NextResponse.json({ options: await qualificationOptions(orgId) });
    if (kind === "sites") {
      const customer = search.get("customer") ?? "";
      if (!isUuid(customer))
        return NextResponse.json({ error: "Choose the customer first." }, { status: 400 });
      return NextResponse.json(await customerSites(authz, customer));
    }
    return NextResponse.json({ error: "Unknown option list." }, { status: 400 });
  },
});
