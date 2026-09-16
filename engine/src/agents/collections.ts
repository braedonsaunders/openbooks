import type { ContinuousCloseDetectorPolicy } from "../continuous-close-config.ts";
import type { AgentFinding } from "./types.ts";

/**
 * Collections pack — overdue balances by customer with payment behaviour,
 * broken payment promises, and credit-hold candidates. Proposes reminder
 * drafts and a priority call list; never writes.
 *
 * Detectors land with the collections commit; until then the pack is
 * registered but quiet so the control plane, policies, and scheduler stay
 * uniform across all six agents.
 */
export const COLLECTIONS_DETECTOR_KEYS = [
  "overdue_customer_balance",
  "broken_payment_promise",
  "credit_hold_candidate",
] as const;

export async function collectionsFindings(
  _orgId: string,
  _agentThreshold: string,
  _detectors: ContinuousCloseDetectorPolicy[],
): Promise<AgentFinding[]> {
  return [];
}
