import "server-only";
import type { ApplicationToolDefinition } from "./tool-definition";
import { RESOURCING_APPLICATION_TOOLS } from "./time-tools-resourcing";
import { SCHEDULING_APPLICATION_TOOLS } from "./time-tools-scheduling";
import { FIELD_TIME_APPLICATION_TOOLS } from "./time-tools-field";
import { TIMESHEETS_APPLICATION_TOOLS } from "./time-tools-timesheets";
import { WORK_SCHEDULE_APPLICATION_TOOLS } from "./time-tools-work-schedules";

const timeTools: ApplicationToolDefinition[] = [
  ...FIELD_TIME_APPLICATION_TOOLS,
  ...TIMESHEETS_APPLICATION_TOOLS,
  ...WORK_SCHEDULE_APPLICATION_TOOLS,
  ...RESOURCING_APPLICATION_TOOLS,
  ...SCHEDULING_APPLICATION_TOOLS,
];

export const TIME_APPLICATION_TOOLS: ApplicationToolDefinition[] = timeTools;
