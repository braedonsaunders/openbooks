import { sql } from "drizzle-orm";
import type { WarehouseStatus } from "@openbooks/schema";
import { db, type SqlExecutor } from "../platform/db.ts";
import { InventoryError, type Runner } from "./contracts.ts";
import { lockInventoryPosition } from "./position.ts";
import { WarehouseRefusal, assertWarehousingFeature } from "./warehouse-admission.ts";
import {
  WAREHOUSE_SELECT,
  writeWarehouseAudit,
  lockWarehouse,
  type WarehouseRecord,
} from "./warehouse-records.ts";
import { warehousePositions, assertWarehouseEmpty } from "./warehouse-positions.ts";
type Transition = "activate" | "suspend" | "retire";

const TRANSITION_TARGET: Record<Transition, WarehouseStatus> = {
  activate: "active",
  suspend: "suspended",
  retire: "retired",
};

const TRANSITION_FROM: Record<Transition, readonly WarehouseStatus[]> = {
  activate: ["draft", "suspended"],
  suspend: ["active"],
  retire: ["active", "suspended"],
};

function transitionRefusal(verb: Transition, warehouse: WarehouseRecord): WarehouseRefusal {
  const target = TRANSITION_TARGET[verb];
  let remedy: string;
  if (warehouse.status === target) remedy = `it is already ${target}; no change is needed`;
  else if (warehouse.status === "retired")
    remedy =
      "a retired warehouse keeps its history and never reopens; create a new warehouse instead";
  else remedy = "activate it first";
  return new WarehouseRefusal(
    `cannot ${verb} ${warehouse.code} from ${warehouse.status}; ${remedy}`,
    "warehouse_transition_refused",
    remedy,
  );
}

function transitionReason(verb: Transition, reason: string | null | undefined): string | null {
  const trimmed = reason?.trim() ?? "";
  if (verb !== "activate" && trimmed.length < 3) {
    throw new WarehouseRefusal(
      `a reason is required to ${verb} a warehouse`,
      "reason_required",
      "enter why the warehouse is changing status",
      422,
    );
  }
  if (trimmed.length > 500) {
    throw new WarehouseRefusal(
      "the reason must be at most 500 characters",
      "invalid_input",
      "shorten the reason",
      422,
    );
  }
  return trimmed === "" ? null : trimmed;
}

export interface WarehouseTransitionInput {
  warehouseId: string;
  reason?: string | null;
}

async function transitionWarehouse(
  verb: Transition,
  orgId: string,
  actorId: string | null,
  input: WarehouseTransitionInput,
): Promise<WarehouseRecord> {
  const reason = transitionReason(verb, input.reason);
  return db.transaction(async (tx) => {
    await assertWarehousingFeature(tx, orgId);
    if (verb === "retire") {
      // Canonical lock order: fence every position the warehouse holds before
      // any row lock. Positions are discovered lock-free, then re-read below.
      for (const position of await warehousePositions(tx, orgId, input.warehouseId)) {
        await lockInventoryPosition(tx, position.itemId, position.stockLocationId);
      }
    }
    const before = await lockWarehouse(tx, orgId, input.warehouseId);
    if (!TRANSITION_FROM[verb].includes(before.status)) throw transitionRefusal(verb, before);
    if (verb === "retire") await assertWarehouseEmpty(tx, orgId, before);
    const target = TRANSITION_TARGET[verb];
    const updated = await tx.execute<never>(sql`
      update warehouses
         set status = ${target}, status_changed_at = now(), status_changed_by = ${actorId},
             updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and stock_location_id = ${input.warehouseId} and status = ${before.status}`);
    if ((updated.rowCount ?? 0) !== 1) {
      throw new InventoryError(
        `warehouse ${before.code} changed while it was being updated; reload and try again`,
      );
    }
    const after = (
      await tx.execute<WarehouseRecord>(
        sql`
      ${WAREHOUSE_SELECT}
       where w.org_id = ${orgId} and w.stock_location_id = ${input.warehouseId}`,
        "objects",
      )
    )[0]!;
    await writeWarehouseAudit(tx, orgId, actorId, input.warehouseId, "update", {
      event: "warehouse_status",
      reason,
      before: { status: before.status },
      after: { status: after.status },
    });
    return after;
  });
}

export const activateWarehouse = (
  orgId: string,
  actorId: string | null,
  input: WarehouseTransitionInput,
) => transitionWarehouse("activate", orgId, actorId, input);
export const suspendWarehouse = (
  orgId: string,
  actorId: string | null,
  input: WarehouseTransitionInput,
) => transitionWarehouse("suspend", orgId, actorId, input);
export const retireWarehouse = (
  orgId: string,
  actorId: string | null,
  input: WarehouseTransitionInput,
) => transitionWarehouse("retire", orgId, actorId, input);

/**
 * Warehouses visible to one legal entity: org-wide locations plus locations
 * scoped to the entity itself or to an ancestor that includes its children —
 * the same admission rule postings enforce, so a default can never route
 * stock somewhere the movement would refuse.
 */
const ENTITY_VISIBLE_WAREHOUSES = (orgId: string, subsidiaryId: string | null) => sql`
  and (
    l.subsidiary_id is null
    ${
      subsidiaryId
        ? sql`or l.subsidiary_id = ${subsidiaryId}
              or (l.subsidiary_include_children and l.subsidiary_id in (
                with recursive ancestors(id) as (
                  select parent_id from subsidiaries where org_id = ${orgId} and id = ${subsidiaryId}
                  union all
                  select s.parent_id from subsidiaries s join ancestors a on s.id = a.id where s.parent_id is not null
                )
                select id from ancestors where id is not null
              ))`
        : sql``
    }
  )
`;

/**
 * The default warehouse for one legal entity: its designated row first,
 * then the company-wide row, then the implicit default when exactly one
 * active warehouse is visible to the entity. Returns null when the answer
 * is genuinely ambiguous (several warehouses, no designation). A designated
 * warehouse that died (deactivated, retired, or rescoped away) fails closed
 * naming the setting — silently falling through to another warehouse would
 * misroute stock the operator explicitly placed.
 */
export async function resolveDefaultWarehouse(
  runner: Runner | SqlExecutor,
  orgId: string,
  subsidiaryId: string | null,
): Promise<string | null> {
  // The designations table arrives with its migration; orgs that have not
  // installed it yet resolve the implicit default instead of failing.
  const installed = (
    await runner.execute<{ installed: boolean }>(
      sql`
    select to_regclass('public.warehouse_defaults') is not null as installed`,
      "objects",
    )
  )[0]?.installed;
  let designated: { warehouse_id: string } | undefined;
  if (installed) {
    designated = (
      await runner.execute<{ warehouse_id: string }>(
        sql`
    select warehouse_id
      from warehouse_defaults
     where org_id = ${orgId}
       and is_active
       and (subsidiary_id is null or subsidiary_id = ${subsidiaryId})
     order by subsidiary_id nulls last
     limit 1`,
        "objects",
      )
    )[0];
  }
  if (designated) {
    const usable = (
      await runner.execute<{ id: string }>(
        sql`
      select sl.id
        from stock_locations sl
        join locations l on l.id = sl.location_id and l.org_id = sl.org_id
        join warehouses w on w.stock_location_id = sl.id and w.org_id = sl.org_id
       where sl.org_id = ${orgId}
         and sl.id = ${designated.warehouse_id}
         and sl.is_active
         and sl.kind = 'warehouse'
         and w.status = 'active'
         ${ENTITY_VISIBLE_WAREHOUSES(orgId, subsidiaryId)}`,
        "objects",
      )
    )[0];
    if (!usable) {
      throw new WarehouseRefusal(
        `the designated default warehouse is not an active warehouse visible to this legal entity — choose another default in Setup → Warehouse defaults`,
        "warehouse_default_invalid",
        `choose an active default in Setup → Warehouse defaults`,
        422,
      );
    }
    return usable.id;
  }
  const single = await runner.execute<{ id: string }>(
    sql`
    select sl.id
      from stock_locations sl
      join locations l on l.id = sl.location_id and l.org_id = sl.org_id
      join warehouses w on w.stock_location_id = sl.id and w.org_id = sl.org_id
     where sl.org_id = ${orgId}
       and sl.is_active
       and sl.kind = 'warehouse'
       and w.status = 'active'
       ${ENTITY_VISIBLE_WAREHOUSES(orgId, subsidiaryId)}`,
    "objects",
  );
  return single.length === 1 ? single[0]!.id : null;
}

/**
 * Ensure a first warehouse for an org that has none: when exactly one
 * active location exists, create the default warehouse under it through the
 * native creation statements and audit trail, ready to receive. Returns the
 * new warehouse id, or null when creation would be a guess (several
 * locations) — the caller then refuses naming Warehouse → Warehouses.
 * Advisory-locked per org so concurrent first receipts create one row, not
 * one per receipt; the code derivation retries past races.
 */
export async function ensureDefaultWarehouse(
  runner: Runner | SqlExecutor,
  orgId: string,
  actorId: string | null,
  subsidiaryId: string | null = null,
): Promise<string | null> {
  await runner.execute(
    sql`select pg_advisory_xact_lock(hashtext(${"warehouse-default:" + orgId}))`,
  );
  // Re-resolve under the lock: a concurrent receipt may have designated or
  // created the default while this caller waited. Never adopt an arbitrary
  // existing row — an ambiguous answer stays a refusal at the call site.
  // Resolution itself needs no feature gate; only creating master data
  // under a disabled switchboard does.
  const resolved = await resolveDefaultWarehouse(runner, orgId, subsidiaryId);
  if (resolved) return resolved;
  const total = (
    await runner.execute<{ n: string }>(
      sql`
    select count(*)::text as n from stock_locations
     where org_id = ${orgId} and is_active and kind = 'warehouse'`,
      "objects",
    )
  )[0];
  if (Number(total?.n ?? "0") > 0) return null;
  const locations = await runner.execute<{ id: string; name: string; code: string | null }>(
    sql`
    select id, name, code from locations where org_id = ${orgId} and is_active`,
    "objects",
  );
  if (locations.length !== 1) return null;
  await assertWarehousingFeature(runner as Runner, orgId, { lock: true });
  const site = locations[0]!;
  const stem =
    (site.code ?? site.name)
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "")
      .slice(0, 12) || "MAIN";
  for (let attempt = 1; attempt <= 9; attempt++) {
    const code = attempt === 1 ? `${stem}-WH` : `${stem}-WH-${attempt}`;
    const inserted = (
      await runner.execute<{ id: string }>(
        sql`
      insert into stock_locations (org_id, location_id, code, kind, is_active, created_by, updated_by)
      values (${orgId}, ${site.id}, ${code}, 'warehouse', true, ${actorId}, ${actorId})
      -- A code already taken is benign: the loop tries the next suffix.
      on conflict do nothing
      returning id`,
        "objects",
      )
    )[0];
    if (inserted) {
      await runner.execute(sql`
        update warehouses
           set name = ${`${site.name} Warehouse`},
               status_changed_at = now(), status_changed_by = ${actorId},
               updated_at = now(), updated_by = ${actorId}
         where org_id = ${orgId} and stock_location_id = ${inserted.id}`);
      const record = (
        await runner.execute<WarehouseRecord>(
          sql`
        ${WAREHOUSE_SELECT}
         where w.org_id = ${orgId} and w.stock_location_id = ${inserted.id}`,
          "objects",
        )
      )[0]!;
      await writeWarehouseAudit(runner, orgId, actorId, inserted.id, "insert", {
        event: "warehouse_created",
        source: "default",
        after: record,
      });
      return inserted.id;
    }
    // Another receipt won the race (or the code predates this flow): adopt
    // a live winner as-is — never rename or reaudit a row this flow did not
    // create. Only an active warehouse answers; anything else tries the
    // next code.
    const winner = (
      await runner.execute<{ id: string }>(
        sql`
      select sl.id
        from stock_locations sl
        join warehouses w on w.stock_location_id = sl.id and w.org_id = sl.org_id
       where sl.org_id = ${orgId}
         and sl.kind = 'warehouse'
         and sl.code = ${code}
         and sl.is_active
         and w.status = 'active'
       limit 1`,
        "objects",
      )
    )[0];
    if (winner) return winner.id;
  }
  return null;
}
