import type { ContinuousCloseAgentKey } from "../continuous-close-config.ts";
import { accountingFindings } from "./accounting.ts";
import { collectionsFindings } from "./collections.ts";
import { financeFindings } from "./finance.ts";
import { forensicsFindings } from "./forensics.ts";
import { hygieneFindings } from "./hygiene.ts";
import { payablesFindings } from "./payables.ts";
import { payrollFindings } from "./payroll.ts";
import { reconciliationFindings } from "./reconciliation.ts";
import { taxFindings } from "./tax.ts";
import { projectsFindings } from "./projects.ts";
import type { AgentPackFindings } from "./types.ts";

/**
 * The single agent-pack registry: every background agent key maps to exactly
 * one detector function behind the shared `AgentPackFindings` signature. The
 * control plane dispatches through `AGENT_PACKS[agentKey]` — never a
 * per-agent branch — so adding an agent is registry + config + pack, with the
 * compiler (`Record<ContinuousCloseAgentKey, …>`) refusing a key without an
 * implementation.
 */
export const AGENT_PACKS: Record<ContinuousCloseAgentKey, AgentPackFindings> = {
  accounting: accountingFindings,
  finance: financeFindings,
  collections: collectionsFindings,
  payables: payablesFindings,
  reconciliation: reconciliationFindings,
  hygiene: hygieneFindings,
  forensics: forensicsFindings,
  tax: taxFindings,
  payroll: payrollFindings,
  projects: projectsFindings,
};
