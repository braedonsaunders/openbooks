import type { ContinuousCloseDetectorPolicy } from "../continuous-close-config.ts";
import type { AgentFinding } from "./types.ts";

/**
 * Payables pack — duplicate/near-duplicate bills, bills due before the next
 * pay run, early-pay discount opportunities, and bills missing approvals.
 * Proposes a pay run as a review card (AP cockpit planner semantics); never
 * writes.
 *
 * Detectors land with the payables commit; until then the pack is registered
 * but quiet so the control plane, policies, and scheduler stay uniform
 * across all six agents.
 */
export const PAYABLES_DETECTOR_KEYS = [
  "duplicate_bills",
  "bills_due_before_payrun",
  "early_pay_discount_opportunity",
  "bills_missing_approval",
] as const;

export async function payablesFindings(
  _orgId: string,
  _agentThreshold: string,
  _detectors: ContinuousCloseDetectorPolicy[],
): Promise<AgentFinding[]> {
  return [];
}
