import "server-only";
import type { ApplicationToolDefinition } from "./tool-definition";
import {
  RECRUITING_APPLICATION_TOOLS,
  RECRUITING_READ_APPLICATION_TOOLS,
} from "./talent-tools-recruiting";
import { PERFORMANCE_APPLICATION_TOOLS } from "./talent-tools-performance";
import {
  TRAINING_APPLICATION_TOOLS,
  TRAINING_READ_APPLICATION_TOOLS,
  QUALIFICATION_APPLICATION_TOOLS,
} from "./talent-tools-training";
import { COMPENSATION_APPLICATION_TOOLS } from "./talent-tools-compensation";
import { SURVEY_APPLICATION_TOOLS } from "./talent-tools-surveys";

/** Recruiting, performance, compensation, training, qualifications and surveys commands for the assistant, MCP and the v1 command API. */
export const TALENT_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  ...RECRUITING_APPLICATION_TOOLS,
  ...RECRUITING_READ_APPLICATION_TOOLS,
  ...PERFORMANCE_APPLICATION_TOOLS,
  ...TRAINING_APPLICATION_TOOLS,
  ...TRAINING_READ_APPLICATION_TOOLS,
  ...QUALIFICATION_APPLICATION_TOOLS,
  ...COMPENSATION_APPLICATION_TOOLS,
  ...SURVEY_APPLICATION_TOOLS,
];
