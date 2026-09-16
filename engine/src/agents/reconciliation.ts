import type { ContinuousCloseDetectorPolicy } from "../continuous-close-config.ts";
import type { AgentFinding } from "./types.ts";

/**
 * Reconciliation pack — unmatched bank lines with a confident match
 * candidate, stale reconciliations, and accounts never reconciled. Proposes
 * match_bank_line commands; never writes.
 *
 * Detectors land with the reconciliation commit; until then the pack is
 * registered but quiet so the control plane, policies, and scheduler stay
 * uniform across all six agents.
 */
export const RECONCILIATION_DETECTOR_KEYS = [
  "bank_line_match_candidate",
  "stale_reconciliation",
  "never_reconciled_account",
] as const;

export async function reconciliationFindings(
  _orgId: string,
  _agentThreshold: string,
  _detectors: ContinuousCloseDetectorPolicy[],
): Promise<AgentFinding[]> {
  return [];
}
