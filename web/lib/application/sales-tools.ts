import "server-only";
import type { ApplicationToolDefinition } from "./tool-definition";
import { SALES_ORDER_APPLICATION_TOOLS } from "./sales-tools-orders";
import { SALES_POS_APPLICATION_TOOLS } from "./sales-tools-pos";
import { SALES_FULFILLMENT_APPLICATION_TOOLS } from "./sales-tools-fulfillment";
import { SALES_RETURN_APPLICATION_TOOLS } from "./sales-tools-returns";
import { SALES_COMMERCIAL_APPLICATION_TOOLS } from "./sales-tools-commercial";
import { SALES_QUOTE_TO_CASH_APPLICATION_TOOLS } from "./sales-tools-quote-to-cash";
import { SALES_SHIPPING_APPLICATION_TOOLS } from "./sales-tools-shipping";
import { SALES_CASH_APPLICATION_TOOLS } from "./sales-tools-cash";
import { SALES_BILLING_REQUEST_APPLICATION_TOOLS } from "./sales-tools-billing-requests";
import { SALES_INTERNAL_BILLING_APPLICATION_TOOLS } from "./sales-tools-internal-billing";
import { SALES_BILLING_IMPORT_APPLICATION_TOOLS } from "./sales-tools-billing-import";
import { SALES_QUOTE_AWARD_APPLICATION_TOOLS } from "./sales-tools-quote-award";
import { SALES_RELATIONSHIP_APPLICATION_TOOLS } from "./sales-tools-relationships";

/** Quotes, sales orders, cash sales, point of sale, fulfillment, shipping, returns and billing commands for the assistant, MCP and the v1 command API. */
export const SALES_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  ...SALES_ORDER_APPLICATION_TOOLS,
  ...SALES_POS_APPLICATION_TOOLS,
  ...SALES_FULFILLMENT_APPLICATION_TOOLS,
  ...SALES_RETURN_APPLICATION_TOOLS,
  ...SALES_COMMERCIAL_APPLICATION_TOOLS,
  ...SALES_QUOTE_TO_CASH_APPLICATION_TOOLS,
  ...SALES_SHIPPING_APPLICATION_TOOLS,
  ...SALES_CASH_APPLICATION_TOOLS,
  ...SALES_BILLING_REQUEST_APPLICATION_TOOLS,
  ...SALES_INTERNAL_BILLING_APPLICATION_TOOLS,
  ...SALES_BILLING_IMPORT_APPLICATION_TOOLS,
  ...SALES_QUOTE_AWARD_APPLICATION_TOOLS,
  ...SALES_RELATIONSHIP_APPLICATION_TOOLS,
];
