import "server-only";
import type { ApplicationToolDefinition } from "./tool-definition";
import { TREASURY_PAYMENT_TOOLS } from "./treasury-tools-payments";
import { TREASURY_AUTOPAY_TOOLS } from "./treasury-tools-autopay";
import { TREASURY_BANKING_TOOLS } from "./treasury-tools-banking";
import { TREASURY_STORED_VALUE_TOOLS } from "./treasury-tools-stored-value";
import { TREASURY_COLLECTION_TOOLS } from "./treasury-tools-collections";
import { TREASURY_WITHHOLDING_TOOLS } from "./treasury-tools-withholding";
import { TREASURY_TAX_TOOLS } from "./treasury-tools-tax";
import { TREASURY_DUNNING_TOOLS } from "./treasury-tools-dunning";
import { TREASURY_INFORMATION_RETURN_TOOLS } from "./treasury-tools-information-returns";

/** Banking, payments, autopay, tax, withholding, stored value, statements and dunning commands for the assistant, MCP and the v1 command API. */
export const TREASURY_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  ...TREASURY_PAYMENT_TOOLS,
  ...TREASURY_AUTOPAY_TOOLS,
  ...TREASURY_BANKING_TOOLS,
  ...TREASURY_STORED_VALUE_TOOLS,
  ...TREASURY_COLLECTION_TOOLS,
  ...TREASURY_WITHHOLDING_TOOLS,
  ...TREASURY_TAX_TOOLS,
  ...TREASURY_DUNNING_TOOLS,
  ...TREASURY_INFORMATION_RETURN_TOOLS,
];
