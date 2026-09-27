import "server-only";
import { z } from "zod";
import { db } from "@openbooks/engine/src/platform/db.ts";
import {
  getFulfillmentDocument,
  listFulfillmentDocuments,
  PICK_LIST_KIND,
  SHIPMENT_KIND,
  type FulfillmentKind,
} from "@openbooks/engine/src/sales/fulfillment.ts";
import type { Authz } from "../authz";
import { isFeatureEnabled } from "../features";
import type { AssistantToolDef, ToolResult } from "./types";
import { uuidInput } from "./tools-shared";

/**
 * Pick-list and shipment reads behind the same gate as the Pick Lists and
 * Shipments pages: `orders.fulfill` and the Fulfillment feature. Every read
 * goes through the engine, which refuses by name while Fulfillment is off
 * and narrows rows to the caller's subsidiaries; a document outside that
 * scope answers exactly like one that does not exist.
 */

const MAX_ROWS = 200;

const listInput = z.object({
  openOnly: z.boolean().optional().describe("Only documents not yet complete or voided. Default false"),
  limit: z.number().int().min(1).max(MAX_ROWS).optional().describe("Default 50"),
});

async function listDocuments(kind: FulfillmentKind, raw: unknown, authz: Authz): Promise<ToolResult> {
  const a = raw as { openOnly?: boolean; limit?: number };
  const limit = Math.min(a.limit ?? 50, MAX_ROWS);
  // One row past the limit tells the model whether more exist.
  const rows = await listFulfillmentDocuments(db, authz.user.orgId, {
    kind,
    openOnly: a.openOnly ?? false,
    limit: Math.min(limit + 1, MAX_ROWS),
    allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
  });
  const items = rows.slice(0, limit);
  return {
    ok: true,
    data: {
      returned: items.length,
      truncated: rows.length > items.length,
      items,
      href: kind === PICK_LIST_KIND ? "/picks" : "/shipments",
    },
  };
}

async function getDocument(kind: FulfillmentKind, raw: unknown, authz: Authz): Promise<ToolResult> {
  const { id } = raw as { id: string };
  const document = await getFulfillmentDocument(db, authz.user.orgId, id, authz.allowedSubsidiaryIds);
  if (!document || document.kind !== kind) return { ok: false, error: "not found" };
  return { ok: true, data: { ...document, href: kind === PICK_LIST_KIND ? "/picks" : "/shipments" } };
}

const listPickListsTool: AssistantToolDef = {
  name: "list_pick_lists",
  description:
    "Pick lists newest first: number, status (draft, pending approval, approved = released, voided), stage (open or done), date, customer, sales order and warehouse. A released, open pick list holds its bin stock for the order. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["orders.fulfill"] },
  feature: "fulfillment",
  inputSchema: listInput,
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "warehousing"))) {
      return { ok: false, error: "warehousing_feature_disabled" };
    }
    if (!(await isFeatureEnabled(authz.user.orgId, "fulfillment"))) {
      return { ok: false, error: "fulfillment_feature_disabled" };
    }
    return listDocuments(PICK_LIST_KIND, raw, authz);
  },
};

const getPickListTool: AssistantToolDef = {
  name: "get_pick_list",
  description:
    "One pick list by id: its sales order, warehouse, shipment if any, and each line's item, bin, quantity, lot or serial and order line. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["orders.fulfill"] },
  feature: "fulfillment",
  inputSchema: z.object({
    id: uuidInput.describe("Pick list id from list_pick_lists"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "warehousing"))) {
      return { ok: false, error: "warehousing_feature_disabled" };
    }
    if (!(await isFeatureEnabled(authz.user.orgId, "fulfillment"))) {
      return { ok: false, error: "fulfillment_feature_disabled" };
    }
    return getDocument(PICK_LIST_KIND, raw, authz);
  },
};

const listShipmentsTool: AssistantToolDef = {
  name: "list_shipments",
  description:
    "Shipments newest first: number, status, stage (open or done), date, customer, sales order, warehouse, carrier, service, tracking number and tracking link. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["orders.fulfill"] },
  feature: "fulfillment",
  inputSchema: listInput,
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "warehousing"))) {
      return { ok: false, error: "warehousing_feature_disabled" };
    }
    if (!(await isFeatureEnabled(authz.user.orgId, "fulfillment"))) {
      return { ok: false, error: "fulfillment_feature_disabled" };
    }
    return listDocuments(SHIPMENT_KIND, raw, authz);
  },
};

const getShipmentTool: AssistantToolDef = {
  name: "get_shipment",
  description:
    "One shipment by id: its pick list and sales order, carrier, service, tracking number and link, ship-to address, the sales fulfilment it recorded once complete, and each line's item, bin, quantity and carton. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["orders.fulfill"] },
  feature: "fulfillment",
  inputSchema: z.object({
    id: uuidInput.describe("Shipment id from list_shipments"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "warehousing"))) {
      return { ok: false, error: "warehousing_feature_disabled" };
    }
    if (!(await isFeatureEnabled(authz.user.orgId, "fulfillment"))) {
      return { ok: false, error: "fulfillment_feature_disabled" };
    }
    return getDocument(SHIPMENT_KIND, raw, authz);
  },
};

export const FULFILLMENT_TOOLS: AssistantToolDef[] = [
  listPickListsTool,
  getPickListTool,
  listShipmentsTool,
  getShipmentTool,
];
