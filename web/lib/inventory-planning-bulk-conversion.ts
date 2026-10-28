import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { convertTransferSuggestion, listPlanSuggestions } from "@openbooks/engine/inventory";
import { DemandPlanningError } from "@openbooks/engine/inventory";
import { db } from "@openbooks/engine/platform/database";
import { can, guardSubsidiaryScope } from "./authz";
import { planningTransaction } from "@/app/api/inventory/planning/_transaction";
import { convertBuyGroup, type BuyConvertLine } from "@/app/api/inventory/planning/_buy";

import type { Authz } from "./authz";

export const Body = z
  .object({
    subsidiaryId: uuidString().describe("Subsidiary id visible to the caller."),
    lines: z
      .array(
        z
          .object({
            id: uuidString().describe("Suggestion id from list_plan_suggestions."),
            vendorId: uuidString()
              .optional()
              .describe("Supplier id for a buy suggestion when no preferred supplier is saved."),
            fromLocationId: uuidString()
              .optional()
              .describe("Source stock location for a transfer suggestion."),
          })
          .strict()
          .describe("One confirmed suggestion and its optional conversion details."),
      )
      .min(1)
      .max(200)
      .describe("Confirmed suggestions to convert in this batch, up to 200."),
  })
  .strict();

export async function bulkConvertPlanSuggestions(
  authz: Authz,
  body: z.infer<typeof Body>,
): Promise<Response> {
  return planningTransaction(authz.user.orgId, async () => {
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
          "suggestion_not_suggested",
          "select suggestions from the current plan",
          404,
        );
      }
      if (row.runStatus === "superseded") {
        throw new DemandPlanningError(
          `Planning suggestion for ${row.itemCode} belongs to a superseded run.`,
          "run_superseded",
          "re-run the demand plan before converting",
          409,
        );
      }
      if (row.status === "converted" && row.convertedRefId) {
        replayed.push({ id: row.id, targetId: row.convertedRefId });
        continue;
      }
      if (row.status !== "confirmed") {
        throw new DemandPlanningError(
          `Confirm the suggestion for ${row.itemCode} before converting it.`,
          "suggestion_not_confirmed",
          "confirm the suggestion first",
          409,
        );
      }
      if (row.action === "buy") buys.push({ row, vendorId: line.vendorId });
      else transfers.push({ row, fromLocationId: line.fromLocationId });
    }
    if (buys.length > 0 && !can(authz, "purchase_orders.create")) {
      return Response.json(
        {
          error: "forbidden",
          permission: "purchase_orders.create",
          message: "Missing required grant: purchase_orders.create.",
        },
        { status: 403 },
      );
    }
    if (transfers.length > 0 && !can(authz, "items.post")) {
      return Response.json(
        {
          error: "forbidden",
          permission: "items.post",
          message: "Missing required grant: items.post.",
        },
        { status: 403 },
      );
    }
    const purchaseOrders: Array<{
      id: string;
      supplierId: string;
      suggestionIds: string[];
      replayed: boolean;
    }> = [];
    const groups = new Map<
      string,
      { supplierId: string; lines: BuyConvertLine[]; dueDate: string }
    >();
    for (const { row, vendorId } of buys) {
      const supplierId = vendorId ?? row.supplierId;
      if (!supplierId) {
        throw new DemandPlanningError(
          `Choose a vendor for ${row.itemCode} before converting.`,
          "vendor_required",
          "choose a vendor before converting the suggestion",
          400,
        );
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
    for (const group of [...groups.values()].sort((a, b) =>
      a.supplierId.localeCompare(b.supplierId),
    )) {
      group.lines.sort((a, b) => a.suggestionId.localeCompare(b.suggestionId));
      purchaseOrders.push({
        ...(await convertBuyGroup(
          {
            user: authz.user,
            allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
            permissions: authz.permissions,
          },
          {
            subsidiaryId: body.subsidiaryId,
            supplierId: group.supplierId,
            dueDate: group.dueDate,
            lines: group.lines,
          },
        )),
        supplierId: group.supplierId,
      });
    }
    const convertedTransfers: Array<{ id: string; suggestionId: string; replayed: boolean }> = [];
    for (const { row, fromLocationId } of transfers) {
      if (!fromLocationId) {
        throw new DemandPlanningError(
          `A transfer of ${row.itemCode} needs its source location.`,
          "transfer_locations_required",
          "choose the location to move stock from",
          400,
        );
      }
      const converted = await convertTransferSuggestion(
        db,
        authz.user.orgId,
        authz.user.id,
        row.id,
        {
          fromStockLocationId: fromLocationId,
        },
      );
      convertedTransfers.push({
        id: converted.id,
        suggestionId: row.id,
        replayed: converted.replayed,
      });
    }
    return Response.json(
      { purchaseOrders, transfers: convertedTransfers, replayed },
      { status: 201 },
    );
  });
}
