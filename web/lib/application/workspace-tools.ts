import "server-only";
import type { ApplicationToolDefinition } from "./tool-definition";
import { WORKSPACE_FILE_TOOLS } from "./workspace-files-tools";
import { WORKSPACE_OPERATION_TOOLS } from "./workspace-operations-tools";
import { WORKSPACE_REPORT_TOOLS } from "./workspace-reports-tools";
import { WORKSPACE_TRANSFER_TOOLS } from "./workspace-transfer-tools";
import { WORKSPACE_DATA_TOOLS } from "./workspace-data-tools";
import { WORKSPACE_VIEW_TOOLS } from "./workspace-view-tools";
import { WORKSPACE_PDF_TOOLS } from "./workspace-pdf-tools";
import { WORKSPACE_ANALYTICS_TOOLS } from "./workspace-analytics-tools";

/** File cabinet, documents, reports, insights, notifications and data transfer commands for the assistant, MCP and the v1 command API. */
export const WORKSPACE_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  ...WORKSPACE_FILE_TOOLS,
  ...WORKSPACE_OPERATION_TOOLS,
  ...WORKSPACE_REPORT_TOOLS,
  ...WORKSPACE_TRANSFER_TOOLS,
  ...WORKSPACE_DATA_TOOLS,
  ...WORKSPACE_VIEW_TOOLS,
  ...WORKSPACE_PDF_TOOLS,
  ...WORKSPACE_ANALYTICS_TOOLS,
];
