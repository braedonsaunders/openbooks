import "server-only";
import { z } from "zod";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { listPutawayRules } from "@openbooks/engine/src/inventory/putaway.ts";
import { getWarehouse, listWarehouseLocations, listWarehouses } from "@openbooks/engine/src/inventory/warehouses.ts";
import { AvailabilityRefusal, getAvailableToPromise } from "@openbooks/engine/src/inventory/availability.ts";
import { replenishmentProposals } from "@openbooks/engine/src/inventory/replenishment.ts";
import { isFeatureEnabled } from "../features";
import { availabilityEntityScope, availabilityRefusalText } from "../availability-report";
import type { AssistantToolDef, ToolResult } from "./types";
import { uuidInput } from "./tools-shared";

/**
 * Warehouse reads behind the same gate as the Warehouse page: `items.read`
 * and the Warehousing feature. Warehouses are organization-wide
 * configuration and carry no legal-entity figures, so no subsidiary filter
 * applies to them. Availability and replenishment are per legal entity and
 * read only an entity the caller can see, exactly as their reports do.
 */

const listWarehousesTool: AssistantToolDef = {
  name: "list_warehouses",
  description:
    "Every warehouse with its code, name, lifecycle status (draft, active, suspended, retired) and address. Draft and retired warehouses take no stock; suspended ones take no inbound stock. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["items.read"] },
  feature: "warehousing",
  inputSchema: z.object({}),
  execute: async (_raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "warehousing"))) return { ok: false, error: "warehousing_feature_disabled" };
    const warehouses = await listWarehouses(db, authz.user.orgId);
    return { ok: true, data: { total: warehouses.length, warehouses, href: "/warehouse" } };
  },
};

const getWarehouseTool: AssistantToolDef = {
  name: "get_warehouse",
  description:
    "One warehouse by id with its zones, bins and staging locations and its putaway rules in the order they are tried. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["items.read"] },
  feature: "warehousing",
  inputSchema: z.object({
    id: uuidInput.describe("Warehouse id from list_warehouses"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "warehousing"))) return { ok: false, error: "warehousing_feature_disabled" };
    const { id } = raw as { id: string };
    const orgId = authz.user.orgId;
    const warehouse = await getWarehouse(db, orgId, id);
    if (!warehouse) return { ok: false, error: "not found" };
    return {
      ok: true,
      data: {
        warehouse,
        locations: await listWarehouseLocations(db, orgId, id),
        putawayRules: await listPutawayRules(db, orgId, id),
        href: `/warehouse?warehouse=${id}`,
      },
    };
  },
};

/**
 * The legal entity a tool reads: the one asked for when the caller can see
 * it, otherwise the caller's default. An entity outside the caller's scope
 * answers "not found", the same as one that does not exist.
 */
async function toolEntity(authz: Parameters<AssistantToolDef["execute"]>[1], requested: string | undefined) {
  const scope = await availabilityEntityScope(authz, requested);
  if (requested && scope.selectedId !== requested) return null;
  return scope.selectedId;
}

/** A refusal reaches the model with its code and remedy, never as an opaque failure. */
function refused(error: unknown): ToolResult {
  if (!(error instanceof AvailabilityRefusal)) throw error;
  return { ok: false, error: `${error.code}: ${availabilityRefusalText(error)}` };
}

const itemAvailabilityTool: AssistantToolDef = {
  name: "get_item_availability",
  description:
    "Available to promise for one stocked item and one legal entity, optionally in one warehouse, in the item's base unit: on hand, committed (open quantity of issued sales orders at those locations), available (on hand less committed) and unallocated (open sales-order demand with no stock location). Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["items.read"] },
  feature: "warehousing",
  inputSchema: z.object({
    itemId: uuidInput.describe("Item id"),
    warehouseId: uuidInput.optional().describe("Warehouse id from list_warehouses; omit for every location"),
    subsidiaryId: uuidInput.optional().describe("Legal entity; omit for the caller's default entity"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "warehousing"))) return { ok: false, error: "warehousing_feature_disabled" };
    const input = raw as { itemId: string; warehouseId?: string; subsidiaryId?: string };
    const subsidiaryId = await toolEntity(authz, input.subsidiaryId);
    if (!subsidiaryId) return { ok: false, error: "not found" };
    try {
      const availability = await getAvailableToPromise(db, authz.user.orgId, { ...input, subsidiaryId });
      const query = new URLSearchParams({ q: availability.itemLabel, sub: subsidiaryId, ...(input.warehouseId ? { warehouse: input.warehouseId } : {}) });
      return { ok: true, data: { ...availability, href: `/reports/availability?${query}` } };
    } catch (error) {
      return refused(error);
    }
  },
};

const replenishmentTool: AssistantToolDef = {
  name: "list_replenishment_proposals",
  description:
    "Replenishment proposals for one legal entity: for each active stocked item, on hand, committed, unallocated demand, on order (open issued purchase orders), projected supply, the reorder point and preferred stock level, the proposed quantity, a status (reorder, covered, no_reorder_point, points_inverted) and the vendor of the last receipt. Proposes only; never orders. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["items.read"] },
  feature: "warehousing",
  inputSchema: z.object({
    subsidiaryId: uuidInput.optional().describe("Legal entity; omit for the caller's default entity"),
    status: z.enum(["reorder", "covered", "no_reorder_point", "points_inverted"]).optional().describe("Only lines with this status"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "warehousing"))) return { ok: false, error: "warehousing_feature_disabled" };
    const input = raw as { subsidiaryId?: string; status?: string };
    const subsidiaryId = await toolEntity(authz, input.subsidiaryId);
    if (!subsidiaryId) return { ok: false, error: "not found" };
    try {
      const lines = (await replenishmentProposals(db, authz.user.orgId, { subsidiaryId }))
        .filter((line) => !input.status || line.status === input.status);
      return { ok: true, data: { subsidiaryId, total: lines.length, lines, href: `/reports/replenishment?sub=${subsidiaryId}` } };
    } catch (error) {
      return refused(error);
    }
  },
};

export const WAREHOUSE_TOOLS: AssistantToolDef[] = [
  listWarehousesTool,
  getWarehouseTool,
  itemAvailabilityTool,
  replenishmentTool,
];
