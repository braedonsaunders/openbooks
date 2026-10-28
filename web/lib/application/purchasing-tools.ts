import "server-only";
import type { ApplicationToolDefinition } from "./tool-definition";
import { PURCHASING_ORDER_TOOLS } from "./purchasing-tools-orders";
import { PURCHASING_RECEIPT_TOOLS } from "./purchasing-tools-receipts";
import { PURCHASING_AP_TOOLS } from "./purchasing-tools-ap";
import { PURCHASING_EXPENSE_TOOLS } from "./purchasing-tools-expenses";
import { PURCHASING_SUBCONTRACT_TOOLS } from "./purchasing-tools-subcontracts";
import { PURCHASING_COMPLIANCE_TOOLS } from "./purchasing-tools-compliance";
import { PURCHASING_EXPENSE_RECEIPT_TOOLS } from "./purchasing-tools-expense-receipts";
import { PURCHASING_COMPLIANCE_EXCEPTION_TOOLS } from "./purchasing-tools-compliance-exceptions";

/** Purchase orders, AP capture, expenses, receipts, subcontracts and subcontractor compliance commands for the assistant, MCP and the v1 command API. */
export const PURCHASING_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  ...PURCHASING_ORDER_TOOLS,
  ...PURCHASING_AP_TOOLS,
  ...PURCHASING_EXPENSE_TOOLS,
  ...PURCHASING_EXPENSE_RECEIPT_TOOLS,
  ...PURCHASING_SUBCONTRACT_TOOLS,
  ...PURCHASING_COMPLIANCE_TOOLS,
  ...PURCHASING_COMPLIANCE_EXCEPTION_TOOLS,
  ...PURCHASING_RECEIPT_TOOLS,
];
