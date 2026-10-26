import { sql, type SQL } from "drizzle-orm";
import { uuidArray } from "../organization/subsidiaries.ts";
import { db } from "../platform/db.ts";
import { InventoryError } from "./contracts.ts";
import {
  assertItemVariantsFeature,
  assertRate,
  BARCODE_KINDS,
  ItemFamilyError,
  MAX_GENERATED_PER_CALL,
  requiredText,
  type BulkBarcodeInput,
  type VariantRow,
} from "./item-family-model.ts";
import { lockFamily, writeFamilyAudit } from "./item-family-store.ts";

/**
 * Variant maintenance: bulk-edit price, cost, barcode or status across a
 * family's variants in one audited transaction, and detach a variant back
 * into a standalone catalog item.
 */

export interface BulkEditVariantsInput {
  variantIds: string[];
  /** Fence route-scoped edits before any mutation. */
  expectedFamilyId?: string;
  price?: string | null;
  cost?: string | null;
  barcode?: BulkBarcodeInput | null;
  isActive?: boolean | null;
}

export interface BulkEditVariantsResult {
  familyId: string;
  updated: string[];
}

/**
 * Set price, cost, barcode or active status across selected variants in one
 * audited transaction. Every id must be a variant of one family; anything
 * else is refused naming the item.
 */
export function bulkEditVariants(
  orgId: string,
  actorId: string | null,
  input: BulkEditVariantsInput & { expectedFamilyId: string },
): Promise<BulkEditVariantsResult | null>;
export function bulkEditVariants(
  orgId: string,
  actorId: string | null,
  input: BulkEditVariantsInput,
): Promise<BulkEditVariantsResult>;
export async function bulkEditVariants(
  orgId: string,
  actorId: string | null,
  input: BulkEditVariantsInput,
): Promise<BulkEditVariantsResult | null> {
  const ids = [...new Set(input.variantIds)];
  if (ids.length === 0) {
    throw new ItemFamilyError(
      "no variants were chosen",
      "variants_required",
      "choose at least one variant",
      422,
    );
  }
  if (ids.length > MAX_GENERATED_PER_CALL) {
    throw new ItemFamilyError(
      `${ids.length} variants exceed the ${MAX_GENERATED_PER_CALL} edited per call`,
      "too_many_variants",
      `edit in smaller selections of at most ${MAX_GENERATED_PER_CALL} variants`,
      422,
    );
  }
  const touchesSomething =
    input.price !== undefined ||
    input.cost !== undefined ||
    input.barcode !== undefined ||
    input.isActive !== undefined;
  if (!touchesSomething) {
    throw new ItemFamilyError(
      "nothing was set",
      "field_required",
      "set a price, cost, barcode, or status",
      422,
    );
  }
  const price = input.price === undefined ? undefined : assertRate(input.price, "price");
  const cost = input.cost === undefined ? undefined : assertRate(input.cost, "cost");
  if (input.barcode !== undefined && input.barcode !== null && ids.length > 1) {
    // One value cannot identify several items: the scan resolver refuses
    // ambiguous values, so sharing a barcode would strand every variant.
    throw new ItemFamilyError(
      `barcode ${input.barcode.value.trim()} cannot identify ${ids.length} variants at once`,
      "barcode_shared",
      "set the barcode on one variant at a time",
      422,
    );
  }
  let barcode: { value: string; kind: string } | null | undefined;
  if (input.barcode !== undefined) {
    if (input.barcode === null) {
      barcode = null;
    } else {
      const value = requiredText(input.barcode.value, "a barcode", 200);
      if (!(BARCODE_KINDS as readonly string[]).includes(input.barcode.kind)) {
        throw new ItemFamilyError(
          `barcode kind ${input.barcode.kind} is unknown`,
          "invalid_barcode_kind",
          `choose one of ${BARCODE_KINDS.join(", ")}`,
          422,
        );
      }
      barcode = { value, kind: input.barcode.kind };
    }
  }
  return db.transaction(async (tx) => {
    await assertItemVariantsFeature(tx, orgId);
    const rows = await tx.execute<VariantRow & { family_id: string | null }>(
      sql`
      select id, code, name, option_values, kind, unit, default_rate, default_cost, is_active, family_id
        from items
       where org_id = ${orgId} and id = any(${uuidArray(ids)}::uuid[])
       order by id
       for update`,
      "objects",
    );
    // A write that matches zero rows is a failure: under RLS an unscoped
    // read resolves to nothing, so a short count refuses here.
    if (rows.length !== ids.length) {
      throw new ItemFamilyError(
        "one or more chosen items are not in this organization",
        "variant_not_found",
        "choose variants from the item catalog of this organization",
        422,
      );
    }
    const familyIds = new Set(rows.map((row) => row.family_id));
    if (familyIds.has(null)) {
      const plain = rows.find((row) => row.family_id === null);
      if (!plain)
        throw new InventoryError("the selected family membership changed; reload the item catalog");
      throw new ItemFamilyError(
        `${plain.code ?? plain.name} is not a variant of any family`,
        "not_a_variant",
        "choose items that belong to a product family",
        422,
      );
    }
    if (familyIds.size !== 1) {
      throw new ItemFamilyError(
        "the chosen variants belong to more than one family",
        "mixed_families",
        "edit one family's variants at a time",
        422,
      );
    }
    const familyId = rows[0]!.family_id!;
    if (input.expectedFamilyId !== undefined && familyId !== input.expectedFamilyId) return null;
    await lockFamily(tx, orgId, familyId);
    if (barcode !== undefined && barcode !== null) {
      const taken = (
        await tx.execute<{ item_id: string; code: string | null; name: string }>(
          sql`
        select i.id as item_id, i.code, i.name
          from item_identifiers ii
          join items i on i.id = ii.item_id and i.org_id = ii.org_id
         where ii.org_id = ${orgId} and ii.value = ${barcode.value} and ii.item_id <> all(${uuidArray(ids)}::uuid[])`,
          "objects",
        )
      )[0];
      if (taken) {
        throw new ItemFamilyError(
          `barcode ${barcode.value} is already used by ${taken.code ?? taken.name}`,
          "barcode_taken",
          `choose a different barcode; ${taken.code ?? taken.name} already scans to it`,
          409,
        );
      }
    }
    const updated: string[] = [];
    for (const row of rows) {
      const assignments: SQL[] = [];
      // Null clears the money field; undefined leaves it unchanged. A null
      // status is unchanged too — a boolean cannot be cleared.
      if (price !== undefined) assignments.push(sql`default_rate = ${price}::numeric`);
      if (cost !== undefined) assignments.push(sql`default_cost = ${cost}::numeric`);
      if (input.isActive !== undefined && input.isActive !== null)
        assignments.push(sql`is_active = ${input.isActive}`);
      if (assignments.length > 0) {
        assignments.push(sql`updated_at = now()`, sql`updated_by = ${actorId}`);
        const next = await tx.execute<never>(sql`
          update items set ${sql.join(assignments, sql`, `)} where org_id = ${orgId} and id = ${row.id}`);
        if ((next.rowCount ?? 0) !== 1)
          throw new InventoryError(`variant ${row.code ?? row.name} update matched no row`);
      }
      if (barcode !== undefined) {
        if (barcode === null) {
          await tx.execute(sql`delete from item_identifiers
            where org_id = ${orgId} and item_id = ${row.id}
              and kind in (${sql.join(
                BARCODE_KINDS.map((kind) => sql`${kind}`),
                sql`, `,
              )})`);
        } else {
          const identifier = (
            await tx.execute<{ id: string }>(
              sql`
            select id from item_identifiers where org_id = ${orgId} and item_id = ${row.id} and kind = ${barcode.kind}`,
              "objects",
            )
          )[0];
          if (identifier) {
            const moved = await tx.execute<never>(sql`
              update item_identifiers set value = ${barcode.value}, updated_at = now(), updated_by = ${actorId}
               where org_id = ${orgId} and id = ${identifier.id}`);
            if ((moved.rowCount ?? 0) !== 1)
              throw new InventoryError(
                `variant ${row.code ?? row.name} barcode update matched no row`,
              );
          } else {
            const added = (
              await tx.execute<{ id: string }>(
                sql`
              insert into item_identifiers (org_id, item_id, kind, value, created_by, updated_by)
              values (${orgId}, ${row.id}, ${barcode.kind}, ${barcode.value}, ${actorId}, ${actorId})
              returning id`,
                "objects",
              )
            )[0];
            if (!added)
              throw new InventoryError(`variant ${row.code ?? row.name} barcode was not created`);
          }
        }
      }
      await writeFamilyAudit(tx, orgId, actorId, "items", row.id, "update", {
        event: "variant_bulk_edited",
        before: {
          defaultRate: row.default_rate,
          defaultCost: row.default_cost,
          isActive: row.is_active,
        },
        after: {
          defaultRate: price === undefined ? row.default_rate : price,
          defaultCost: cost === undefined ? row.default_cost : cost,
          isActive:
            input.isActive === undefined || input.isActive === null
              ? row.is_active
              : input.isActive,
          barcode: barcode === undefined ? "(unchanged)" : barcode,
        },
      });
      updated.push(row.id);
    }
    return { familyId, updated };
  });
}

/**
 * Detach a variant from its family. The item stays in the catalog with its
 * code, name, stock and history; only the family membership is removed.
 */
export async function detachVariant(
  orgId: string,
  actorId: string | null,
  itemId: string,
): Promise<{ id: string; familyId: string }> {
  return db.transaction(async (tx) => {
    await assertItemVariantsFeature(tx, orgId);
    const row = (
      await tx.execute<{
        id: string;
        code: string | null;
        name: string;
        family_id: string | null;
        option_values: unknown;
      }>(
        sql`
      select id, code, name, family_id, option_values
        from items
       where org_id = ${orgId} and id = ${itemId}
       for update`,
        "objects",
      )
    )[0];
    if (!row) {
      throw new ItemFamilyError(
        "the item is not in this organization",
        "variant_not_found",
        "choose an item from the catalog of this organization",
        422,
      );
    }
    if (row.family_id === null) {
      throw new ItemFamilyError(
        `${row.code ?? row.name} is not a variant of any family`,
        "not_a_variant",
        "only a variant item can be detached from its family",
        422,
      );
    }
    const updated = await tx.execute<never>(sql`
      update items
         set family_id = null, option_values = null, updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${itemId}`);
    if ((updated.rowCount ?? 0) !== 1)
      throw new InventoryError(`variant ${row.code ?? row.name} detach matched no row`);
    await writeFamilyAudit(tx, orgId, actorId, "items", itemId, "update", {
      event: "variant_detached",
      before: { familyId: row.family_id, optionValues: row.option_values },
      after: { familyId: null, optionValues: null },
    });
    return { id: itemId, familyId: row.family_id };
  });
}
