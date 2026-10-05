import { z } from "zod";
import {
  convertTransferSuggestion,
  getPlanSuggestion,
  listPlanSuggestions,
} from "@openbooks/engine/inventory";
import { DemandPlanningError } from "@openbooks/engine/inventory";
import { db } from "@openbooks/engine/platform/database";
import { guardSubsidiaryScope } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { planningTransaction } from "../../../_transaction";
import { convertBuyGroup } from "../../../_buy";

const Params = z.object({ id: z.string().uuid() });
// A purchase takes its vendor from the body, falling back to the suggestion's
// resolved supplier; a transfer takes its source location from the body.
const Body = z.union([
  z.object({}).strict().transform(() => ({ vendorId: undefined, fromLocationId: undefined })),
  z.object({ vendorId: z.string().uuid(), fromLocationId: z.string().uuid().optional() }).strict(),
  z.object({ fromLocationId: z.string().uuid(), vendorId: z.string().uuid().optional() }).strict(),
], { error: "Send an empty object for the saved plan, or valid vendor/location identifiers." });

export const POST = defineRoute({
  permission: "inventory.plan", feature: "demandPlanning", params: Params, body: Body,
  invalidBodyStatus: 422,
  handler: async ({ authz, params, body }) => planningTransaction(authz.user.orgId, async () => {
    const suggestion = await getPlanSuggestion(db, authz.user.orgId, params.id);
    const denied = guardSubsidiaryScope(authz, suggestion.subsidiaryId);
    if (denied) return denied;
    if (suggestion.status === "converted" && suggestion.converted_ref_id) {
      return Response.json({ id: suggestion.converted_ref_id, action: suggestion.action, replayed: true }, { status: 200 });
    }
    if (suggestion.action === "buy") {
      if (!authz.permissions.has("ap.create")) {
        return Response.json({ error: "forbidden", permission: "ap.create", message: "Missing required grant: ap.create." }, { status: 403 });
      }
      const resolved = (await listPlanSuggestions(db, authz.user.orgId, suggestion.subsidiaryId, "all"))
        .find((row) => row.id === params.id);
      const supplierId = body.vendorId ?? resolved?.supplierId ?? null;
      if (!supplierId) {
        throw new DemandPlanningError(
          `Choose a vendor for ${suggestion.item_code?.trim() || suggestion.item_name} before converting.`,
          "vendor_required", "choose a vendor before converting the suggestion", 400);
      }
      if (!suggestion.base_unit) {
        throw new DemandPlanningError(
          "This item has no inventory unit configured.",
          "item_not_stocked", "add an inventory costing profile with a base unit", 409);
      }
      const result = await convertBuyGroup(
        { user: authz.user, allowedSubsidiaryIds: authz.allowedSubsidiaryIds, permissions: authz.permissions },
        {
          subsidiaryId: suggestion.subsidiaryId,
          supplierId,
          dueDate: suggestion.due_date,
          lines: [{
            suggestionId: params.id,
            itemId: suggestion.item_id,
            itemLabel: suggestion.item_code?.trim() || suggestion.item_name,
            quantity: suggestion.quantity,
            unit: suggestion.base_unit,
            stockLocationId: suggestion.stock_location_id,
            dueDate: suggestion.due_date,
            runNumber: `run ${suggestion.run_number}`,
          }],
        },
      );
      return Response.json({ ...result, action: "buy" }, { status: result.replayed ? 200 : 201 });
    }
    if (!authz.permissions.has("items.post")) {
      return Response.json({ error: "forbidden", permission: "items.post", message: "Missing required grant: items.post." }, { status: 403 });
    }
    if (!body.fromLocationId) {
      throw new DemandPlanningError(
        "A transfer suggestion needs its source location.",
        "transfer_locations_required", "choose the location to move stock from", 400);
    }
    const result = await convertTransferSuggestion(db, authz.user.orgId, authz.user.id, params.id, {
      fromStockLocationId: body.fromLocationId,
    });
    return Response.json(result, { status: result.replayed ? 200 : 201 });
  }),
});
