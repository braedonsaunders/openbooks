import "server-only";
import type { ApplicationToolDefinition } from "./tool-definition";
import { PAYROLL_RUN_APPLICATION_TOOLS } from "./payroll-tools-runs";
import { PAYROLL_OPERATION_APPLICATION_TOOLS } from "./payroll-tools-operations";
import { PAYROLL_COMPENSATION_APPLICATION_TOOLS } from "./payroll-tools-compensation";
import { PAYROLL_FILING_APPLICATION_TOOLS } from "./payroll-tools-filings";
import { PAYROLL_ANOMALY_APPLICATION_TOOLS } from "./payroll-tools-anomalies";
import { PAYROLL_PROFILE_APPLICATION_TOOLS } from "./payroll-tools-profiles";
import { PAYROLL_EMPLOYMENT_APPLICATION_TOOLS } from "./payroll-tools-employment";
import { PAYROLL_CONFIGURATION_APPLICATION_TOOLS } from "./payroll-tools-configuration";
import { PAYROLL_OPENING_APPLICATION_TOOLS } from "./payroll-tools-openings";
import { PAYROLL_PARALLEL_APPLICATION_TOOLS } from "./payroll-tools-parallel";
import { PAYROLL_CERTIFICATE_APPLICATION_TOOLS } from "./payroll-tools-certificates";
import { PAYROLL_SOURCE_AUTHORITY_APPLICATION_TOOLS } from "./payroll-tools-source-authority";
import { PAYROLL_HOLIDAY_ASSERTION_APPLICATION_TOOLS } from "./payroll-tools-holiday-assertions";

/** Payroll commands for the assistant, MCP and the v1 command API. */
export const PAYROLL_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  ...PAYROLL_RUN_APPLICATION_TOOLS,
  ...PAYROLL_OPERATION_APPLICATION_TOOLS,
  ...PAYROLL_COMPENSATION_APPLICATION_TOOLS,
  ...PAYROLL_FILING_APPLICATION_TOOLS,
  ...PAYROLL_ANOMALY_APPLICATION_TOOLS,
  ...PAYROLL_PROFILE_APPLICATION_TOOLS,
  ...PAYROLL_EMPLOYMENT_APPLICATION_TOOLS,
  ...PAYROLL_CONFIGURATION_APPLICATION_TOOLS,
  ...PAYROLL_OPENING_APPLICATION_TOOLS,
  ...PAYROLL_PARALLEL_APPLICATION_TOOLS,
  ...PAYROLL_CERTIFICATE_APPLICATION_TOOLS,
  ...PAYROLL_SOURCE_AUTHORITY_APPLICATION_TOOLS,
  ...PAYROLL_HOLIDAY_ASSERTION_APPLICATION_TOOLS,
];
