import "server-only";
import type { ApplicationToolDefinition } from "./tool-definition";
import { HRM_EMPLOYMENT_TOOLS } from "./hrm-tools-employment";
import { HRM_PROCESS_TOOLS } from "./hrm-tools-processes";
import { HRM_LEAVE_TOOLS } from "./hrm-tools-leave";
import { HRM_BENEFIT_TOOLS } from "./hrm-tools-benefits";
import { HRM_DOCUMENT_TOOLS } from "./hrm-tools-documents";
import { HRM_COMPLIANCE_TOOLS } from "./hrm-tools-compliance";
import { HRM_EXIT_TOOLS } from "./hrm-tools-exits";
import { HRM_SELF_SERVICE_TOOLS } from "./hrm-tools-self-service";

/** Workforce records, employment lifecycle, leave, benefits, HR documents and compliance commands for the assistant, MCP and the v1 command API. */
export const HRM_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  ...HRM_EMPLOYMENT_TOOLS,
  ...HRM_PROCESS_TOOLS,
  ...HRM_LEAVE_TOOLS,
  ...HRM_BENEFIT_TOOLS,
  ...HRM_DOCUMENT_TOOLS,
  ...HRM_COMPLIANCE_TOOLS,
  ...HRM_EXIT_TOOLS,
  ...HRM_SELF_SERVICE_TOOLS,
];
