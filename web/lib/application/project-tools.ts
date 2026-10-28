import "server-only";
import type { ApplicationToolDefinition } from "./tool-definition";
import { PROJECT_FIELD_TOOLS } from "./project-tools-field";
import { PROJECT_CONSTRUCTION_TOOLS } from "./project-tools-construction";
import { PROJECT_BILLING_TOOLS } from "./project-tools-billing";
import { PROJECT_MERGE_TOOLS } from "./project-tools-merge";
import { PROJECT_PROPERTY_TOOLS } from "./project-tools-property";
import { PROJECT_EQUIPMENT_TOOLS } from "./project-tools-equipment";
import { PROJECT_LABOR_TOOLS } from "./project-tools-labor";
import { PROJECT_PREBILLING_TOOLS } from "./project-tools-prebilling";
import { PROJECT_SCHEDULE_TOOLS } from "./project-tools-schedule";
import { PROJECT_WORK_TOOLS } from "./project-tools-work";

/** Projects, project charges, schedules, pre-billing, field tickets, labor rate cards, equipment, construction and property commands for the assistant, MCP and the v1 command API. */
export const PROJECT_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  ...PROJECT_WORK_TOOLS,
  ...PROJECT_PREBILLING_TOOLS,
  ...PROJECT_SCHEDULE_TOOLS,
  ...PROJECT_FIELD_TOOLS,
  ...PROJECT_CONSTRUCTION_TOOLS,
  ...PROJECT_BILLING_TOOLS,
  ...PROJECT_MERGE_TOOLS,
  ...PROJECT_PROPERTY_TOOLS,
  ...PROJECT_EQUIPMENT_TOOLS,
  ...PROJECT_LABOR_TOOLS,
];
