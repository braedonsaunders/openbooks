import { can, type Authz } from "./authz";

/**
 * The doorway to the unified approvals worklist: a caller who cannot approve
 * anything sees no union. Flows gates (every routed approval, payment runs
 * included) and gateless documents ride `flows.approve`; pending budget
 * scenarios ride `budgets.approve`. The worklist reader, the inbox, the
 * dashboard tile, vitals and the assistant all decide entry here.
 */
export function maySeeUnion(authz: Authz): boolean {
  return can(authz, "flows.approve") || can(authz, "budgets.approve");
}
