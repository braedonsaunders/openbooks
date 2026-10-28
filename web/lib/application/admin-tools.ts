import "server-only";
import type { ApplicationToolDefinition } from "./tool-definition";
import { ADMIN_AUTOMATION_TOOLS } from "./admin-automation-tools";
import { ADMIN_WEBHOOK_TOOLS } from "./admin-webhook-tools";
import { ADMIN_SCRIPT_TOOLS } from "./admin-script-tools";
import {
  ADMIN_AI_GOVERNANCE_TOOLS,
  ADMIN_AI_SETTINGS_TOOLS,
  ADMIN_CUSTOM_FIELD_TOOLS,
} from "./admin-governance-tools";
import { ADMIN_CONNECTION_TOOLS } from "./admin-connection-tools";
import { ADMIN_EMAIL_TOOLS } from "./admin-email-tools";
import { ADMIN_USER_TOOLS } from "./admin-user-tools";
import { ADMIN_ROLE_TOOLS } from "./admin-role-tools";
import { ADMIN_FLOW_TOOLS } from "./admin-flow-tools";
import { ADMIN_PDF_TEMPLATE_TOOLS } from "./admin-pdf-template-tools";
import { ADMIN_FORM_TOOLS } from "./admin-form-tools";
import { ADMIN_TRANSACTION_FORM_TOOLS } from "./admin-transaction-form-tools";
import { ADMIN_NAVIGATION_TOOLS } from "./admin-navigation-tools";
import { ADMIN_BACKUP_TOOLS } from "./admin-backup-tools";
import { ADMIN_AGENT_TOOLS } from "./admin-agent-tools";
import { ADMIN_FLOW_MANUAL_TOOLS } from "./admin-flow-manual-tools";
import { ADMIN_FLOW_DELEGATION_TOOLS } from "./admin-flow-delegation-tools";
import { ADMIN_PLATFORM_TOOLS } from "./admin-platform-tools";
import { ADMIN_FLOW_QUICK_APPROVAL_TOOLS } from "./admin-flow-quick-approval-tools";
import { ADMIN_BRIEFING_TOOLS } from "./admin-briefing-tools";

/** Administration, customization, flows, automations, scripts, forms and PDF templates commands for the assistant, MCP and the v1 command API. */
export const ADMIN_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  ...ADMIN_AUTOMATION_TOOLS,
  ...ADMIN_WEBHOOK_TOOLS,
  ...ADMIN_SCRIPT_TOOLS,
  ...ADMIN_CUSTOM_FIELD_TOOLS,
  ...ADMIN_AI_GOVERNANCE_TOOLS,
  ...ADMIN_AI_SETTINGS_TOOLS,
  ...ADMIN_CONNECTION_TOOLS,
  ...ADMIN_EMAIL_TOOLS,
  ...ADMIN_USER_TOOLS,
  ...ADMIN_ROLE_TOOLS,
  ...ADMIN_FLOW_TOOLS,
  ...ADMIN_PDF_TEMPLATE_TOOLS,
  ...ADMIN_FORM_TOOLS,
  ...ADMIN_TRANSACTION_FORM_TOOLS,
  ...ADMIN_NAVIGATION_TOOLS,
  ...ADMIN_BACKUP_TOOLS,
  ...ADMIN_AGENT_TOOLS,
  ...ADMIN_FLOW_MANUAL_TOOLS,
  ...ADMIN_FLOW_DELEGATION_TOOLS,
  ...ADMIN_PLATFORM_TOOLS,
  ...ADMIN_FLOW_QUICK_APPROVAL_TOOLS,
  ...ADMIN_BRIEFING_TOOLS,
];
