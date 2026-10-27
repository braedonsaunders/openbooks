import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { loadSubsidiaryContext, uuidArray } from "../organization/subsidiaries.ts";
import { assertTracking } from "./tracking.ts";
import { countTolerance } from "./count-policy.ts";
import { assertInventoryFeature } from "./profile-policy.ts";
import { InventoryError } from "./contracts.ts";
import { getOnHandWith } from "./position.ts";
import { assertCountedOn, assertCountWarehouses, assertPeriodCovers } from "./stock-count-gates.ts";
import type { StockCountStatus } from "./stock-count-gates.ts";

export interface NewCountLineInput {
  itemId: string;
  stockLocationId: string;
  lotId?: string | null;
  serialId?: string | null;
}

export interface CreateStockCountInput {
  locationId: string;
  /** Owning legal entity, stored on the row (0200): the snapshot, the drift
   * check, and every adjustment movement scope to it — never inferred from
   * the posting session. */
  subsidiaryId: string;
  countedOn: string;
  memo?: string | null;
  blind?: boolean;
  lines: NewCountLineInput[];
}

/**
 * Open a draft count, snapshotting each line's expected quantity from live
 * on-hand (count-entity scoped, lot scoped for lot-tracked items) at creation.
 * The snapshot is the baseline the posting drift check compares against.
 */
export async function createStockCount(
  orgId: string,
  actorId: string | null,
  input: CreateStockCountInput,
): Promise<{ id: string; status: StockCountStatus }> {
  assertCountedOn(input.countedOn);
  if (input.lines.length === 0) {
    throw new InventoryError("a stock count needs at least one line — add the items to count");
  }
  if (input.lines.length > 2000) {
    throw new InventoryError("a stock count holds at most 2000 lines — split the count by area");
  }
  return db.transaction(async (tx) => {
    await assertInventoryFeature(tx, orgId);
    await assertPeriodCovers(tx, orgId, input.countedOn);
    const location = await tx.execute<{ id: string }>(
      sql`
      select id from locations where org_id = ${orgId} and id = ${input.locationId}`,
      "objects",
    );
    if (!location[0]) {
      throw new InventoryError(
        "count location not found in this organization — choose an active business location",
      );
    }
    const subsidiary = await tx.execute<{ id: string }>(
      sql`
      select id from subsidiaries where org_id = ${orgId} and id = ${input.subsidiaryId}`,
      "objects",
    );
    if (!subsidiary[0]) {
      throw new InventoryError(
        "count subsidiary not found in this organization — choose an active subsidiary",
      );
    }
    // Validate every subject against the org BEFORE snapshotting: a line
    // scoped to another org's item, or to a stock location outside the
    // count's business location, must refuse by name rather than die on a
    // foreign key. Serial-tracked subjects are counted individually; lot-tracked
    // subjects must name their lot.
    const itemIds = [...new Set(input.lines.map((l) => l.itemId))];
    const items = await tx.execute<{ id: string; code: string | null }>(
      sql`
      select it.id, it.code from items it where it.org_id = ${orgId} and it.id = any(${uuidArray(itemIds)}::uuid[])`,
      "objects",
    );
    const foundItems = new Set(items.map((r) => r.id));
    const itemCodes = new Map(items.map((r) => [r.id, r.code]));
    const profiles = await tx.execute<{ item_id: string; tracking: string }>(
      sql`
      select item_id, tracking from item_inventory_profiles
       where org_id = ${orgId} and item_id = any(${uuidArray(itemIds)}::uuid[])`,
      "objects",
    );
    const trackingByItem = new Map(profiles.map((r) => [r.item_id, r.tracking]));
    const stockLocationIds = [...new Set(input.lines.map((l) => l.stockLocationId))];
    const stockLocations = await tx.execute<{
      id: string;
      location_id: string;
      code: string | null;
    }>(
      sql`
      select id, location_id, code from stock_locations
       where org_id = ${orgId} and id = any(${uuidArray(stockLocationIds)}::uuid[])`,
      "objects",
    );
    const businessByStockLocation = new Map(stockLocations.map((r) => [r.id, r.location_id]));
    const stockLocationCodes = new Map(stockLocations.map((r) => [r.id, r.code]));
    // One line per (item, stock location, lot, serial) subject: duplicate lines
    // would each post the full variance and double-apply one observation.
    // Constraint 0293 arbitrates concurrent writers; this names the offender.
    const seenSubjects = new Set<string>();
    for (const line of input.lines) {
      const subject = `${line.itemId}|${line.stockLocationId}|${line.lotId ?? ""}:${line.serialId ?? ""}`;
      if (seenSubjects.has(subject)) {
        const where = `item ${itemCodes.get(line.itemId) ?? line.itemId} at ${stockLocationCodes.get(line.stockLocationId) ?? line.stockLocationId}${line.lotId ? ` lot ${line.lotId}` : ""}`;
        throw new InventoryError(
          `duplicate count line for ${where} — count each item, stock location, lot and serial once`,
        );
      }
      seenSubjects.add(subject);
    }
    // The warehouses must be active and admit the count's subsidiary BEFORE
    // any draft is stored: otherwise the draft reaches review and dies in
    // adjustInventory, or a zero-variance count posts against a dead or
    // foreign warehouse silently.
    await assertCountWarehouses(
      tx,
      orgId,
      await loadSubsidiaryContext(tx, orgId),
      input.subsidiaryId,
      stockLocationIds,
    );
    const countId = randomUUID();
    const created = await tx.execute(
      sql`
      insert into stock_counts (id, org_id, location_id, subsidiary_id, status, counted_on, memo, blind, created_by, updated_by)
      values (${countId}, ${orgId}, ${input.locationId}, ${input.subsidiaryId},
              'draft', ${input.countedOn}, ${input.memo ?? null}, ${input.blind ?? true}, ${actorId}, ${actorId}) returning id`,
      "objects",
    );
    if (created.length !== 1) throw new InventoryError("Stock count was not created");
    for (const line of input.lines) {
      if (!foundItems.has(line.itemId)) {
        throw new InventoryError(
          "count line item not found in this organization — choose an active item",
        );
      }
      const tracking = trackingByItem.get(line.itemId);
      if (!tracking) {
        throw new InventoryError(
          "count line item has no inventory profile — create its item inventory profile before counting it",
        );
      }
      assertTracking(
        { tracking },
        { quantity: "1", lotId: line.lotId, serialId: line.serialId },
        "count",
      );
      if (line.serialId) {
        const serial = (
          await tx.execute<{ lot_id: string | null }>(
            sql`select lot_id from serials where org_id=${orgId} and id=${line.serialId} and item_id=${line.itemId}`,
            "objects",
          )
        )[0];
        if (
          !serial ||
          (tracking === "lot_serial" && serial.lot_id !== null && serial.lot_id !== line.lotId)
        )
          throw new InventoryError("Count serial must belong to the item and lot");
      }
      const businessLocation = businessByStockLocation.get(line.stockLocationId);
      if (!businessLocation) {
        throw new InventoryError(
          "count line stock location not found in this organization — choose an active stock location",
        );
      }
      if (businessLocation !== input.locationId) {
        throw new InventoryError(
          "count line stock location belongs to a different business location — open a separate count for that location",
        );
      }
      if (line.lotId) {
        const lot = await tx.execute<{ id: string }>(
          sql`
          select id from lots where org_id = ${orgId} and id = ${line.lotId} and item_id = ${line.itemId}`,
          "objects",
        );
        if (!lot[0]) {
          throw new InventoryError(
            "count line lot does not belong to the line's item — choose the item's own lot",
          );
        }
      }
      const basis = await getOnHandWith(tx, orgId, line.itemId, line.stockLocationId, {
        lotId: line.lotId ?? null,
        serialId: line.serialId ?? null,
        subsidiaryId: input.subsidiaryId,
      });
      const tolerance = await countTolerance(
        tx,
        orgId,
        line.itemId,
        input.subsidiaryId,
        input.countedOn,
      );
      const insertedLine = await tx.execute(
        sql`
        insert into stock_count_lines
          (id, org_id, stock_count_id, item_id, stock_location_id, lot_id, serial_id, variance_tolerance,
           expected_quantity, counted_quantity, created_by, updated_by)
        values (${randomUUID()}, ${orgId}, ${countId}, ${line.itemId}, ${line.stockLocationId},
                ${line.lotId ?? null}, ${line.serialId ?? null}, ${tolerance}, ${basis.quantity}, null, ${actorId}, ${actorId}) returning id`,
        "objects",
      );
      if (insertedLine.length !== 1) throw new InventoryError("Stock count line was not created");
    }
    return { id: countId, status: "draft" as StockCountStatus };
  });
}
