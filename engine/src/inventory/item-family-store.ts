import { sql } from "drizzle-orm";
import { uuidArray } from "../organization/subsidiaries.ts";
import { db } from "../platform/db.ts";
import { InventoryError, type Runner } from "./contracts.ts";
import {
  assertItemVariantsReadable,
  ItemFamilyError,
  toFamilyRecord,
  type FamilyOptionRecord,
  type FamilyRow,
  type ItemFamilyDetail,
  type VariantRow,
} from "./item-family-model.ts";

/**
 * Family storage primitives: the audit writer, the row lock, and the
 * option/variant loaders every writer composes inside its transaction, plus
 * the composed family read. Depends only on the model — never on a writer.
 */

export async function writeFamilyAudit(
  tx: Runner,
  orgId: string,
  actorId: string | null,
  table: "item_families" | "items",
  rowId: string,
  action: "insert" | "update",
  changes: Record<string, unknown>,
): Promise<void> {
  const written = await tx.execute<{ id: string }>(
    sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, ${table}, ${rowId}, ${action}, ${JSON.stringify(changes)}::jsonb, ${actorId})
    returning id`,
    "objects",
  );
  if (written.length === 0) {
    throw new InventoryError("family change was not audited; reload and try again");
  }
}

/** Lock the family row for writers; a missing row is outside this organization. */
export async function lockFamily(tx: Runner, orgId: string, familyId: string): Promise<FamilyRow> {
  const row = (
    await tx.execute<FamilyRow>(
      sql`
    select id, code, name, description, category, kind, default_unit, default_rate, status
      from item_families
     where org_id = ${orgId} and id = ${familyId}
     for update`,
      "objects",
    )
  )[0];
  if (!row) {
    throw new ItemFamilyError(
      "the product family is not in this organization",
      "family_not_found",
      "choose a family from the item catalog of this organization",
      422,
    );
  }
  return row;
}

export async function loadOptions(
  tx: Runner,
  orgId: string,
  familyId: string,
): Promise<FamilyOptionRecord[]> {
  const rows = await tx.execute<{ id: string; name: string; position: number; values: string[] }>(
    sql`
    select id, name, position, "values"
      from item_family_options
     where org_id = ${orgId} and family_id = ${familyId}
     order by position`,
    "objects",
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    position: row.position,
    values: row.values ?? [],
  }));
}

export async function loadVariants(
  tx: Runner,
  orgId: string,
  familyId: string,
): Promise<VariantRow[]> {
  return await tx.execute<VariantRow>(
    sql`
    select id, code, name, option_values, kind, unit, default_rate, default_cost, is_active
      from items
     where org_id = ${orgId} and family_id = ${familyId}
     order by code nulls last, name`,
    "objects",
  );
}

/** Read one family with options, variants and on-hand quantities. */
export async function getItemFamily(
  orgId: string,
  familyId: string,
): Promise<ItemFamilyDetail | null> {
  return db.transaction(async (tx) => {
    await assertItemVariantsReadable(tx, orgId);
    const row = (
      await tx.execute<FamilyRow>(
        sql`
      select id, code, name, description, category, kind, default_unit, default_rate, status
        from item_families
       where org_id = ${orgId} and id = ${familyId}`,
        "objects",
      )
    )[0];
    if (!row) return null;
    const options = await loadOptions(tx, orgId, familyId);
    const variants = await loadVariants(tx, orgId, familyId);
    const onHand =
      variants.length === 0
        ? new Map<string, string>()
        : new Map(
            (
              await tx.execute<{ item_id: string; quantity: string }>(
                sql`
        select item_id, coalesce(sum(remaining_quantity), 0)::text as quantity
          from cost_layers
         where org_id = ${orgId} and item_id = any(${uuidArray(variants.map((variant) => variant.id))}::uuid[])
         group by item_id`,
                "objects",
              )
            ).map((entry) => [entry.item_id, entry.quantity] as [string, string]),
          );
    const barcodes =
      variants.length === 0
        ? new Map<string, { value: string; kind: string }>()
        : new Map(
            (
              await tx.execute<{ item_id: string; value: string; kind: string }>(
                sql`
        select distinct on (item_id) item_id, value, kind
          from item_identifiers
         where org_id = ${orgId} and item_id = any(${uuidArray(variants.map((variant) => variant.id))}::uuid[])
         order by item_id, updated_at desc`,
                "objects",
              )
            ).map(
              (entry) =>
                [entry.item_id, { value: entry.value, kind: entry.kind }] as [
                  string,
                  { value: string; kind: string },
                ],
            ),
          );
    return {
      ...toFamilyRecord(row),
      options,
      variants: variants.map((variant) => ({
        id: variant.id,
        code: variant.code,
        name: variant.name,
        optionValues: (variant.option_values ?? {}) as Record<string, string>,
        kind: variant.kind,
        unit: variant.unit,
        defaultRate: variant.default_rate,
        defaultCost: variant.default_cost,
        isActive: variant.is_active,
        onHand: onHand.get(variant.id) ?? "0",
        barcode: barcodes.get(variant.id) ?? null,
      })),
    };
  });
}

/** Active product families available for linking storefront products. */
export async function listItemFamilies(
  orgId: string,
): Promise<{ id: string; code: string; name: string }[]> {
  return db.transaction(async (tx) => {
    await assertItemVariantsReadable(tx, orgId);
    return await tx.execute<{ id: string; code: string; name: string }>(
      sql`
      select id, code, name
        from item_families
       where org_id = ${orgId} and status = 'active'
       order by name, code, id`,
      "objects",
    );
  });
}
