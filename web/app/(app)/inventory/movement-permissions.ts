import { INVENTORY_ACTION_PERMISSIONS } from "@openbooks/engine/src/organization/permissions.ts";
import { can, type Authz } from "../../../lib/authz";

/**
 * Posting actions the New-movement drawer can submit (mirrors the drawer's
 * ACTIONS list). The gate is derived from the same catalogue the postings
 * route enforces — never a duplicated permission literal — so a user who
 * can post sees the button and a user who cannot never does.
 */
const DRAWER_POST_ACTIONS = ["receive", "issue", "adjust", "transfer", "build", "landed"] as const;

export function canPostInventoryMovement(authz: Authz): boolean {
  const grants = new Set(DRAWER_POST_ACTIONS.map((action) => INVENTORY_ACTION_PERMISSIONS[action]));
  for (const grant of grants) if (can(authz, grant)) return true;
  return false;
}
