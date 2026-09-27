import "server-only";
import { z } from "zod";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { listPutawayRules } from "@openbooks/engine/src/inventory/putaway.ts";
import { getWarehouse, listWarehouseLocations, listWarehouses } from "@openbooks/engine/src/inventory/warehouses.ts";
import type { AssistantToolDef, ToolResult } from "./types";
import { uuidInput } from "./tools-shared";

/**
 * Warehouse reads behind the same gate as the Warehouse page: `items.read`
 * and the Warehousing feature. Warehouses are organization-wide
 * configuration and carry no legal-entity figures, so no subsidiary filter
 * applies.
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

export const WAREHOUSE_TOOLS: AssistantToolDef[] = [listWarehousesTool, getWarehouseTool];
