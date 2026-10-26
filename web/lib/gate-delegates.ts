import "server-only";

import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { gateDecisionCapability } from "@openbooks/engine/flows/module";

export type GateDelegateOption = {
  id: string;
  name: string;
};

/**
 * The users a viewer may hand a pending gate to, or none when the hand-off
 * would be refused. Delegation follows the native gate check
 * (`gateDecisionCapability().canDelegate`: the gate's direct assignee or an
 * organization admin), so a record drawer never offers a Delegate picker
 * the delegate path refuses; holding flows.manage alone is not enough.
 */
export async function gateDelegateOptions(
  orgId: string,
  viewerId: string,
  gateId: string | null,
): Promise<GateDelegateOption[]> {
  if (!gateId) return [];
  if (!(await gateDecisionCapability(gateId, viewerId)).canDelegate) return [];
  return await db.execute<GateDelegateOption>(
    sql`
    select id::text as id, name from users
     where org_id = ${orgId} and is_active and id <> ${viewerId}
     order by name limit 500`,
    "objects",
  );
}
