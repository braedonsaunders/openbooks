import { sql } from "drizzle-orm";
import { toUnits } from "../money/money.ts";
import { bomRequiredQuantity } from "../inventory/bom-scrap.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import type { SqlExecutor } from "../platform/db.ts";
import { ManufacturingError } from "./errors.ts";

const MAX_DEPTH = 32;

type BomRow = {
  componentItemId: string;
  componentCode: string;
  quantityPer: string;
  operationSeq: number | null;
  scrapPct: string | null;
  isByproduct: boolean;
};

export interface BomExplosionLine {
  parentItemId: string;
  parentItemCode: string;
  itemId: string;
  itemCode: string;
  requiredQuantity: string;
  operationSeq: number | null;
  path: string[];
}

export interface BomExplosion {
  components: BomExplosionLine[];
  byproducts: BomExplosionLine[];
}

export interface BomWhereUsedPath {
  parentItemId: string;
  parentItemCode: string;
  componentItemId: string;
  operationSeq: number | null;
  path: string[];
}

async function itemCode(tx: SqlExecutor, orgId: string, itemId: string): Promise<string> {
  const result = await tx.execute<{ code: string | null }>(sql`
    select code from items where org_id = ${orgId} and id = ${itemId}`);
  const code = result.rows[0]?.code;
  if (!result.rows[0]) {
    throw new ManufacturingError(`item ${itemId} was not found in this organization`, {
      code: "item_not_found",
      remedy: "Choose an item from this organization.",
    });
  }
  return code?.trim() || itemId;
}

async function effectiveBom(
  tx: SqlExecutor,
  orgId: string,
  itemId: string,
  asOf: string,
): Promise<BomRow[]> {
  const result = await tx.execute<BomRow>(sql`
    select b.component_item_id as "componentItemId",
           component.code as "componentCode",
           b.quantity_per::text as "quantityPer",
           b.operation_seq as "operationSeq",
           b.scrap_pct::text as "scrapPct",
           b.is_byproduct as "isByproduct"
      from bom_components b
      join items component on component.org_id = b.org_id and component.id = b.component_item_id
     where b.org_id = ${orgId}
       and b.assembly_item_id = ${itemId}
       and (b.effective_from is null or b.effective_from <= ${asOf}::date)
       and (b.effective_to is null or ${asOf}::date < b.effective_to)
     order by b.sort_order, b.component_item_id, b.operation_seq nulls first,
              b.is_byproduct, b.effective_from nulls first`);
  return result.rows;
}

async function supplyMethod(
  tx: SqlExecutor,
  orgId: string,
  itemId: string,
): Promise<string | null> {
  const result = await tx.execute<{ supplyMethod: string }>(sql`
    select supply_method as "supplyMethod"
      from mfg_item_policies
     where org_id = ${orgId} and item_id = ${itemId}`);
  return result.rows[0]?.supplyMethod ?? null;
}

function validateAsOf(asOf: string): void {
  if (!isIsoCalendarDate(asOf)) {
    throw new ManufacturingError(`"${asOf}" is not a real calendar date`, {
      code: "invalid_as_of_date",
      remedy: "Pass a real YYYY-MM-DD calendar date.",
    });
  }
}

/** Expand effective BOM rows without posting or mutating inventory. */
export async function explodeBom(
  tx: SqlExecutor,
  orgId: string,
  itemId: string,
  quantity: string,
  asOf: string,
): Promise<BomExplosion> {
  validateAsOf(asOf);
  let quantityUnits: bigint;
  try {
    quantityUnits = /^\+?(?:\d+\.?\d*|\.\d+)$/.test(quantity.trim()) ? toUnits(quantity) : 0n;
  } catch {
    quantityUnits = 0n;
  }
  if (quantityUnits <= 0n) {
    throw new ManufacturingError("explosion quantity must be a positive exact decimal", {
      code: "invalid_quantity",
      remedy: "Pass a positive quantity with no more than four decimal places.",
    });
  }
  const rootCode = await itemCode(tx, orgId, itemId);
  const rootRows = await effectiveBom(tx, orgId, itemId, asOf);
  if (rootRows.length === 0) {
    throw new ManufacturingError(`item ${rootCode} has no bill of materials effective on ${asOf}`, {
      code: "bom_not_found",
      remedy: "Add a BOM line effective on the requested date.",
    });
  }

  const components: BomExplosionLine[] = [];
  const byproducts: BomExplosionLine[] = [];
  const expand = async (
    parentId: string,
    parentCode: string,
    parentQuantity: string,
    pathIds: string[],
    pathCodes: string[],
    rows: BomRow[],
  ): Promise<void> => {
    for (const row of rows) {
      const required = bomRequiredQuantity(parentQuantity, row.quantityPer, row.scrapPct).quantity;
      const path = [...pathCodes, row.componentCode];
      const line: BomExplosionLine = {
        parentItemId: parentId,
        parentItemCode: parentCode,
        itemId: row.componentItemId,
        itemCode: row.componentCode,
        requiredQuantity: required,
        operationSeq: row.operationSeq,
        path,
      };
      if (row.isByproduct) {
        byproducts.push(line);
        continue;
      }

      const cycleAt = pathIds.indexOf(row.componentItemId);
      if (cycleAt >= 0) {
        throw new ManufacturingError(`bill of materials cycle: ${[...pathCodes.slice(cycleAt), row.componentCode].join(" → ")}`, {
          code: "bom_cycle",
          remedy: "Remove a component link from the named cycle.",
        });
      }
      const make = (await supplyMethod(tx, orgId, row.componentItemId)) === "make";
      const childRows = make ? await effectiveBom(tx, orgId, row.componentItemId, asOf) : [];
      if (make && childRows.length > 0) {
        if (pathIds.length > MAX_DEPTH) {
          throw new ManufacturingError(`bill of materials exceeds depth ${MAX_DEPTH}: ${path.join(" → ")}`, {
            code: "bom_too_deep",
            remedy: "Shorten the nested BOM path before exploding it.",
          });
        }
        await expand(
          row.componentItemId,
          row.componentCode,
          required,
          [...pathIds, row.componentItemId],
          [...pathCodes, row.componentCode],
          childRows,
        );
      } else {
        components.push(line);
      }
    }
  };

  await expand(itemId, rootCode, quantity.trim(), [itemId], [rootCode], rootRows);
  return { components, byproducts };
}

/** Return every effective parent path that uses the component as a material. */
export async function whereUsed(
  tx: SqlExecutor,
  orgId: string,
  componentItemId: string,
  asOf: string,
): Promise<BomWhereUsedPath[]> {
  validateAsOf(asOf);
  const componentCode = await itemCode(tx, orgId, componentItemId);
  const paths: BomWhereUsedPath[] = [];
  const walk = async (
    currentId: string,
    pathIds: string[],
    pathCodes: string[],
  ): Promise<void> => {
    const parents = await tx.execute<{
      parentItemId: string;
      parentItemCode: string | null;
      operationSeq: number | null;
    }>(sql`
      select b.assembly_item_id as "parentItemId",
             parent.code as "parentItemCode",
             b.operation_seq as "operationSeq"
        from bom_components b
        join items parent on parent.org_id = b.org_id and parent.id = b.assembly_item_id
       where b.org_id = ${orgId}
         and b.component_item_id = ${currentId}
         and not b.is_byproduct
         and (b.effective_from is null or b.effective_from <= ${asOf}::date)
         and (b.effective_to is null or ${asOf}::date < b.effective_to)
       order by parent.code, b.operation_seq nulls first, b.sort_order`);
    for (const row of parents.rows) {
      const parentCode = row.parentItemCode?.trim() || row.parentItemId;
      const cycleAt = pathIds.indexOf(row.parentItemId);
      if (cycleAt >= 0) {
        throw new ManufacturingError(`bill of materials cycle: ${[parentCode, ...pathCodes.slice(0, cycleAt).reverse(), parentCode].join(" → ")}`, {
          code: "bom_cycle",
          remedy: "Remove a component link from the named cycle.",
        });
      }
      if (pathIds.length > MAX_DEPTH) {
        throw new ManufacturingError(`bill of materials exceeds depth ${MAX_DEPTH}: ${[parentCode, ...pathCodes].join(" → ")}`, {
          code: "bom_too_deep",
          remedy: "Shorten the nested BOM path before checking where-used.",
        });
      }
      const nextIds = [row.parentItemId, ...pathIds];
      const nextCodes = [parentCode, ...pathCodes];
      paths.push({
        parentItemId: row.parentItemId,
        parentItemCode: parentCode,
        componentItemId,
        operationSeq: row.operationSeq,
        path: nextCodes,
      });
      await walk(row.parentItemId, nextIds, nextCodes);
    }
  };
  await walk(componentItemId, [componentItemId], [componentCode]);
  return paths;
}
