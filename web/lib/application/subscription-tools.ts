import "server-only";
import type { ApplicationToolDefinition } from "./tool-definition";
import { SUBSCRIPTION_BASE_TOOLS } from "./subscription-tools-base";
import { SUBSCRIPTION_ADVANCED_TOOLS } from "./subscription-tools-advanced";
import { SUBSCRIPTION_USAGE_TOOLS } from "./subscription-tools-usage";
import { SUBSCRIPTION_REVENUE_TOOLS } from "./subscription-tools-revenue";
import { SUBSCRIPTION_CHANNEL_TOOLS } from "./subscription-tools-channels";

/** Subscriptions, usage billing, revenue recognition and sales channels commands for the assistant, MCP and the v1 command API. */
export const SUBSCRIPTION_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  ...SUBSCRIPTION_BASE_TOOLS,
  ...SUBSCRIPTION_ADVANCED_TOOLS,
  ...SUBSCRIPTION_USAGE_TOOLS,
  ...SUBSCRIPTION_REVENUE_TOOLS,
  ...SUBSCRIPTION_CHANNEL_TOOLS,
];
