import "server-only";
import type { ApplicationToolDefinition } from "./tool-definition";
import { CAPITAL_ASSET_TOOLS } from "./capital-tools-assets";
import { CAPITAL_LEASE_TOOLS } from "./capital-tools-leases";
import { CAPITAL_EQUITY_TOOLS } from "./capital-tools-equity";
import { CAPITAL_NONPROFIT_TOOLS } from "./capital-tools-nonprofit";

/** Fixed assets, leases, equity, funds, grants and encumbrances commands for the assistant, MCP and the v1 command API. */
export const CAPITAL_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  ...CAPITAL_ASSET_TOOLS,
  ...CAPITAL_LEASE_TOOLS,
  ...CAPITAL_EQUITY_TOOLS,
  ...CAPITAL_NONPROFIT_TOOLS,
];
