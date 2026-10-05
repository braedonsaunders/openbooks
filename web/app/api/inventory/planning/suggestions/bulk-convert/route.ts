import { z } from "zod";
import {
  convertTransferSuggestion,
  listPlanSuggestions,
} from "@openbooks/engine/inventory";
import { DemandPlanningError } from "@openbooks/engine/inventory";
import { db } from "@openbooks/engine/platform/database";
import { guardSubsidiaryScope } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { planningTransaction } from "../../_transaction";
import { convertBuyGroup, type BuyConvertLine } from "../../_buy";

const Params = z.object({}).strict();
const Body = z.object({
  subsidiaryId: z.string().uuid(),
  lines: z.array(z.object({
    id: z.string().uuid(),
    vendorId: z.string().uuid().optional(),
    fromLocationId: z.string().uuid().optional(),
  }).strict()).min(1).max(200),
}).strict();

/**
 * Convert a selection of suggestions at once: purchase suggestions group by
 * supplier into one draft purchase order each, transfers convert one by one
 * from their given source locations. Already-converted rows replay their
 * stored targets; anything still suggested names the confirm step first.
 */
export const POST = defineRoute({
  permission: "inventory.plan", feature: "demandPlanning", params: Params, body: Body,
  handler: async ({ authz, body }) => planningTransaction(authz.user.orgId, async () => {
    const denied = guardSubsidiaryScope(authz, body.subsidiaryId);
    if (denied) return denied;
    const resolved = await listPlanSuggestions(db, authz.user.orgId, body.subsidiaryId, "all");
    const byId = new Map(resolved.map((row) => [row.id, row]));
    const replayed: Array<{ id: string; targetId: string }> = [];
    const buys: Array<{ row: (typeof resolved)[number]; vendorId?: string }> = [];
    const transfers: Array<{ row: (typeof resolved)[number]; fromLocationId?: string }> = [];
    for (const line of body.lines) {
      const row = byId.get(line.id);
      if (!row) {
        throw new DemandPlanningError(
          `Planning suggestion ${line.id} is not part of this organization's latest plan.`,
          "suggestion_not_suggested", "select suggestions from the current plan", 404);
      }
      if (row.runStatus === "superseded") {
        throw new DemandPlanningError(
          `Planning suggestion for ${row.itemCode} belongs to a superseded run.`,
          "run_superseded", "re-run the demand plan before converting", 409);
      }
      if (row.status === "converted" && row.convertedRefId) {
        replayed.push({ id: row.id, targetId: row.convertedRefId });
        continue;
      }
      if (row.status !== "confirmed") {
        throw new DemandPlanningError(
          `Confirm the suggestion for ${row.itemCode} before converting it.`,
          "suggestion_not_confirmed", "confirm the suggestion first", 409);
      }
      if (row.action === "buy") buys.push({ row, vendorId: line.vendorId });
      else transfers.push({ row, fromLocationId: line.fromLocationId });
    }
    if (buys.length > 0 && !authz.permissions.has("ap.create")) {
      return Response.json({ error: "forbidden", permission: "ap.create", message: "Missing required grant: ap.create." }, { status: 403 });
    }
    if (transfers.length > 0 && !authz.permissions.has("items.post")) {
      return Response.json({ error: "forbidden", permission: "items.post", message: "Missing required grant: items.post." }, { status: 403 });
    }
    const purchaseOrders: Array<{ id: string; supplierId: string; suggestionIds: string[]; replayed: boolean }> = [];
    const groups = new Map<string, { supplierId: string; lines: BuyConvertLine[]; dueDate: string }>();
    for (const { row, vendorId } of buys) {
      const supplierId = vendorId ?? row.supplierId;
      if (!supplierId) {
        throw new DemandPlanningError(
          `Choose a vendor for ${row.itemCode} before converting.`,
          "vendor_required", "choose a vendor before converting the suggestion", 400);
      }
      const group = groups.get(supplierId) ?? { supplierId, lines: [], dueDate: row.dueDate };
      group.lines.push({
        suggestionId: row.id,
        itemId: row.itemId,
        itemLabel: row.itemCode,
        quantity: row.quantity,
        unit: row.baseUnit,
        stockLocationId: row.stockLocationId,
        dueDate: row.dueDate,
        runNumber: `run ${row.runNumber}`,
      });
      if (row.dueDate < group.dueDate) group.dueDate = row.dueDate;
      groups.set(supplierId, group);
    }
    for (const group of [...groups.values()].sort((a, b) => a.supplierId.localeCompare(b.supplierId))) {
      group.lines.sort((a, b) => a.suggestionId.localeCompare(b.suggestionId));
      purchaseOrders.push({
        ...(await convertBuyGroup(
          { user: authz.user, allowedSubsidiaryIds: authz.allowedSubsidiaryIds, permissions: authz.permissions },
          { subsidiaryId: body.subsidiaryId, supplierId: group.supplierId, dueDate: group.dueDate, lines: group.lines },
        )),
        supplierId: group.supplierId,
      });
    }
    const convertedTransfers: Array<{ id: string; suggestionId: string; replayed: boolean }> = [];
    for (const { row, fromLocationId } of transfers) {
      if (!fromLocationId) {
        throw new DemandPlanningError(
          `A transfer of ${row.itemCode} needs its source location.`,
          "transfer_locations_required", "choose the location to move stock from", 400);
      }
      const converted = await convertTransferSuggestion(db, authz.user.orgId, authz.user.id, row.id, {
        fromStockLocationId: fromLocationId,
      });
      convertedTransfers.push({ id: converted.id, suggestionId: row.id, replayed: converted.replayed });
    }
    return Response.json({ purchaseOrders, transfers: convertedTransfers, replayed }, { status: 201 });
  }),
});
