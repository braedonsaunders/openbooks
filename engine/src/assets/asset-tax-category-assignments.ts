import { sql } from "drizzle-orm";
import { lockAssetCategoryTaxLifecycle } from "../organization/asset-tax-fence.ts";
import { db } from "../platform/db.ts";

export type AssetTaxCategoryAssignmentResult =
  | { kind: "regime_not_found" }
  | { kind: "invalid_class" }
  | { kind: "category_not_found" }
  | { kind: "open_pool"; classCode: string }
  | { kind: "assigned" };

export async function assignAssetTaxCategory(input: {
  orgId: string;
  actorId: string;
  categoryId: string;
  regime: string;
  classCode: string | null;
}): Promise<AssetTaxCategoryAssignmentResult> {
  const regimes = await db.execute<{ class_attribute: string }>(
    sql`
    select class_attribute from tax_regimes where org_id=${input.orgId} and code=${input.regime} and is_active limit 1`,
    "objects",
  );
  const attribute = regimes[0]?.class_attribute;
  if (!attribute) return { kind: "regime_not_found" };

  if (input.classCode) {
    const classRows = await db.execute(
      sql`
      select 1 from tax_pool_classes where org_id=${input.orgId} and regime=${input.regime} and class_code=${input.classCode} and is_active`,
      "objects",
    );
    if (!classRows[0]) return { kind: "invalid_class" };
  }

  return db.transaction(async (tx) => {
    await lockAssetCategoryTaxLifecycle(tx, input.orgId, input.categoryId);
    const before = await tx.execute(
      sql`
      select * from asset_categories where id=${input.categoryId} and org_id=${input.orgId} for update`,
      "objects",
    );
    const beforeRow = before[0] as Record<string, unknown> | undefined;
    if (!beforeRow) return { kind: "category_not_found" };

    const previousAttributes =
      (beforeRow as { tax_attributes?: Record<string, unknown> }).tax_attributes ?? {};
    const previousClass =
      typeof previousAttributes[attribute] === "string" ? previousAttributes[attribute] : null;
    if (previousClass && previousClass !== input.classCode) {
      const openPool = (
        await tx.execute<{ class_code: string }>(
          sql`
        select tp.class_code
          from fixed_assets a
          join asset_categories c on c.id = a.category_id and c.org_id = a.org_id
          join tax_depreciation_pools tp
            on tp.org_id = a.org_id and tp.subsidiary_id = a.subsidiary_id
           and tp.regime = ${input.regime} and tp.class_code = c.tax_attributes->>${attribute}
          join lateral (
            select pp.closing_balance
              from tax_pool_periods pp
             where pp.org_id = tp.org_id and pp.pool_id = tp.id
             order by pp.tax_year desc
             limit 1
          ) latest on true
         where a.org_id = ${input.orgId} and a.category_id = ${input.categoryId}
           and latest.closing_balance <> 0
         limit 1`,
          "objects",
        )
      )[0];
      if (openPool) return { kind: "open_pool", classCode: openPool.class_code };
    }

    const after = input.classCode
      ? await tx.execute(
          sql`
          update asset_categories
             set tax_attributes=jsonb_set(tax_attributes, array[${attribute}], to_jsonb(${input.classCode}::text), true),
                 updated_at=now(), updated_by=${input.actorId}
           where id=${input.categoryId} and org_id=${input.orgId} returning *`,
          "objects",
        )
      : await tx.execute(
          sql`
          update asset_categories set tax_attributes=tax_attributes-${attribute}, updated_at=now(), updated_by=${input.actorId}
           where id=${input.categoryId} and org_id=${input.orgId} returning *`,
          "objects",
        );
    const afterRow = (after[0] ?? null) as Record<string, unknown> | null;
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id)
      values
         (${input.orgId}, 'asset_categories', ${String(input.categoryId)}, 'update',
         ${JSON.stringify({
           before: beforeRow,
           after: afterRow,
           regime: input.regime,
           classCode: input.classCode,
         })}::jsonb,
         ${input.actorId})
    `);
    return { kind: "assigned" };
  });
}
