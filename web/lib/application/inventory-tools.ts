import "server-only";
import type { ApplicationToolDefinition } from "./tool-definition";
import { INVENTORY_FAMILY_TOOLS } from "./inventory-tools-families";
import { INVENTORY_WAREHOUSE_TOOLS } from "./inventory-tools-warehouses";
import { INVENTORY_PLANNING_TOOLS } from "./inventory-tools-planning";
import { INVENTORY_COUNT_TOOLS } from "./inventory-tools-counts";
import { INVENTORY_MOVEMENT_TOOLS } from "./inventory-tools-movements";
import { INVENTORY_TRANSFER_TOOLS } from "./inventory-tools-transfers";
import { INVENTORY_SCHEDULE_TOOLS } from "./inventory-tools-schedules";
import { INVENTORY_ITEM_TOOLS } from "./inventory-tools-items";
import { INVENTORY_EXECUTION_TOOLS } from "./inventory-tools-execution";
import { INVENTORY_RATE_TOOLS } from "./inventory-tools-rates";
import { INVENTORY_PLANNING_BULK_TOOLS } from "./inventory-tools-planning-bulk";

/** Items, item families, rate books, inventory, warehouses and scanning commands for the assistant, MCP and the v1 command API. */
export const INVENTORY_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  ...INVENTORY_FAMILY_TOOLS,
  ...INVENTORY_WAREHOUSE_TOOLS,
  ...INVENTORY_PLANNING_TOOLS,
  ...INVENTORY_COUNT_TOOLS,
  ...INVENTORY_MOVEMENT_TOOLS,
  ...INVENTORY_TRANSFER_TOOLS,
  ...INVENTORY_SCHEDULE_TOOLS,
  ...INVENTORY_ITEM_TOOLS,
  ...INVENTORY_EXECUTION_TOOLS,
  ...INVENTORY_RATE_TOOLS,
  ...INVENTORY_PLANNING_BULK_TOOLS,
];
