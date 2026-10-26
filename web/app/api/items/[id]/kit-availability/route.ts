import { NextResponse } from "next/server";
import { z } from "zod";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import {
  loadKitAvailabilityIdentity,
  loadKitAvailabilityWorkspace,
} from "@openbooks/engine/inventory/kit-availability";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { availabilityEntityScope } from "@/lib/availability-report";
import { isUuid } from "@/lib/list-params";

const itemParams = z.object({ id: z.string() });

/**
 * What a kit can still sell, per warehouse and across all locations: the
 * kit's derived availability (the limiting component decides) with every
 * component's own stock beside it, so the operator sees which component
 * runs out first. A kit without a recipe answers with an empty component
 * list rather than an error — the drawer teaches how to start it.
 */
export const GET = defineRoute({
  permission: "items.read",
  feature: "inventory",
  params: itemParams,
  handler: async ({ params: { id }, authz: gate }) => {
    if (!isUuid(id)) return notFound("record");
    const orgId = gate.user.orgId;
    const item = await loadKitAvailabilityIdentity(orgId, id);
    if (!item || item.kind !== "kit") return notFound("kit", id);
    const entity = await availabilityEntityScope(gate, undefined);
    if (!entity.selectedId)
      return NextResponse.json({
        itemId: id,
        allLocations: { kit: null, components: [] },
        warehouses: [],
      });
    const subsidiaryId = entity.selectedId;
    const businessDate = await businessToday(orgId);
    // No effective recipe: the drawer shows the getting-started state
    // instead of an error page. Any other misconfiguration stays a named refusal.
    // Availability nets reservations inside one legal entity: read the kit
    // through the operator's entity scope, the same scope the availability
    // report renders, so the drawer never promises another entity's stock.
    const workspace = await loadKitAvailabilityWorkspace({
      orgId,
      itemId: id,
      subsidiaryId,
      asOfDate: businessDate,
    });
    if (workspace.kind === "empty") {
      return NextResponse.json({
        itemId: id,
        allLocations: { kit: null, components: [] },
        warehouses: [],
      });
    }
    return NextResponse.json({
      itemId: id,
      allLocations: workspace.allLocations,
      warehouses: workspace.warehouses,
    });
  },
});
