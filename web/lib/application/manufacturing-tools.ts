import "server-only";
import type { ApplicationToolDefinition } from "./tool-definition";
import { MANUFACTURING_MASTER_TOOLS } from "./manufacturing-tools-master";
import { MANUFACTURING_WORK_ORDER_TOOLS } from "./manufacturing-tools-work-orders";
import { MANUFACTURING_MRP_TOOLS } from "./manufacturing-tools-mrp";
import { MANUFACTURING_SUBCONTRACT_TOOLS } from "./manufacturing-tools-subcontracts";
import { MANUFACTURING_QUALITY_TOOLS } from "./manufacturing-tools-quality";
import { MANUFACTURING_READ_TOOLS } from "./manufacturing-tools-read";

/** Manufacturing commands for the assistant, MCP and the v1 command API. */
export const MANUFACTURING_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  ...MANUFACTURING_READ_TOOLS,
  ...MANUFACTURING_MASTER_TOOLS,
  ...MANUFACTURING_WORK_ORDER_TOOLS,
  ...MANUFACTURING_MRP_TOOLS,
  ...MANUFACTURING_SUBCONTRACT_TOOLS,
  ...MANUFACTURING_QUALITY_TOOLS,
] satisfies ApplicationToolDefinition[];
