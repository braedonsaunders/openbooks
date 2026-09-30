import { INVENTORY_ACTION_PERMISSIONS } from "@openbooks/engine/inventory/contracts";
import { can, type Authz } from "../../../lib/authz";

/**
 * Actions the movement drawer can submit, including controlled reversal.
 * The gate derives from the route's catalog; the drawer receives only the
 * verbs the current actor may execute. A reversal grant never grants posting.
 */
const DRAWER_POST_ACTIONS = ["receive", "issue", "adjust", "transfer", "build", "disassemble", "landed", "reverse"] as const;

export function canPostInventoryMovement(authz: Authz): boolean {
  const grants = new Set(DRAWER_POST_ACTIONS.map((action) => INVENTORY_ACTION_PERMISSIONS[action]));
  for (const grant of grants) if (can(authz, grant)) return true;
  return false;
}
