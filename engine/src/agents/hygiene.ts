import type { ContinuousCloseDetectorPolicy } from "../continuous-close-config.ts";
import type { AgentFinding } from "./types.ts";

/**
 * Data-hygiene pack — control-account/type mismatches, duplicate party
 * identities, items without tax codes, projects without cost budgets, budget
 * scenarios with no lines, and unmapped payroll components. Proposes
 * update_setup_record / update_company_settings cards where the fix is a
 * setting; never writes.
 *
 * Detectors land with the data-hygiene commit; until then the pack is
 * registered but quiet so the control plane, policies, and scheduler stay
 * uniform across all six agents.
 */
export const HYGIENE_DETECTOR_KEYS = [
  "control_account_type_mismatch",
  "duplicate_party_identity",
  "item_missing_tax_code",
  "project_missing_cost_budget",
  "budget_scenario_without_lines",
  "unmapped_payroll_component",
] as const;

export async function hygieneFindings(
  _orgId: string,
  _agentThreshold: string,
  _detectors: ContinuousCloseDetectorPolicy[],
): Promise<AgentFinding[]> {
  return [];
}
