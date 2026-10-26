import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import type { Runner } from "./contracts.ts";
import { warehousingDisabledRefusal } from "./warehouse-admission.ts";
import { resolveDefaultWarehouse } from "./warehouse-lifecycle.ts";

/**
 * Which stock the caller measures or moves. Null warehouse with null
 * locations is the org-wide scope; a warehouse id names its whole tree;
 * explicit locations name exactly those rows.
 */
export interface WarehouseScope {
  subsidiaryId?: string | null;
  warehouseId?: string | null;
  stockLocationIds?: readonly string[] | null;
}

/**
 * The one consistent warehousing rule. The feature governs multi-location
 * management — warehouse setup, bins, the transfer-order workflow and
 * measurement across several stock locations. The org's single/default
 * stock location is not multi-location management: single-leg receiving,
 * issuing and counting, and production confined to it, proceed with the
 * feature off. Every genuinely multi-location operation refuses with the
 * same named refusal everywhere; the transfer primitive stays open because
 * subcontract custody, putaway and handling units move stock through it
 * under their own features.
 *
 * The renderer (web/lib/api/route.ts) hands the refusal's remedy through
 * verbatim without inspecting the actor's permissions, so the remedy
 * uniformly names who can change it: an administrator on the Features page.
 */
export async function assertWarehousingForScope(
  runner: Runner,
  orgId: string,
  scope: WarehouseScope,
): Promise<void> {
  if (await orgFeatureEnabled(orgId, "warehousing", runner as SqlExecutor)) return;
  const warehouseId = scope.warehouseId ?? null;
  const explicit = scope.stockLocationIds ?? null;
  if (warehouseId !== null) {
    // A warehouse scope is single-location management exactly when it is
    // the org's default warehouse for the posting entity. Anything else
    // spans locations the operator manages as a network.
    const def = await resolveDefaultWarehouse(runner, orgId, scope.subsidiaryId ?? null);
    if (def !== null && def === warehouseId) return;
    throw warehousingDisabledRefusal();
  }
  if (explicit !== null) {
    // Measuring one named location never needs multi-location management.
    if (explicit.length <= 1) return;
    throw warehousingDisabledRefusal();
  }
  if (await singleWarehouseKindLocation(runner, orgId)) return;
  throw warehousingDisabledRefusal();
}

/** Exactly one active warehouse-kind stock location: the implicit single-location org. */
async function singleWarehouseKindLocation(runner: Runner, orgId: string): Promise<boolean> {
  const rows = (
    await runner.execute<{ n: string }>(
      sql`
    select count(*)::text as n from stock_locations
     where org_id = ${orgId} and is_active and kind = 'warehouse'`,
      "objects",
    )
  )[0];
  return Number(rows?.n ?? "0") === 1;
}
