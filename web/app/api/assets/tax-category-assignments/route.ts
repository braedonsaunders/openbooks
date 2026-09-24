import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { lockAssetCategoryTaxLifecycle } from '@openbooks/engine/src/organization/asset-tax-fence.ts'
import { guardUnrestrictedScope } from '../../../../lib/authz'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { isUuid } from '../../../../lib/list-params'

export const runtime = 'nodejs'

export async function PATCH(req: Request) {
  const gate = await guardFeaturePermission('admin.setup.manage', 'fixedAssets')
  if (gate instanceof NextResponse) return gate
  // Category tax attributes decide how every entity's assets are reported on
  // every filing: org-wide policy, unrestricted scope only.
  const unrestricted = guardUnrestrictedScope(gate)
  if (unrestricted) return unrestricted
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as { categoryId?: string; regime?: string; classCode?: string | null }
  if (!body.categoryId || !isUuid(body.categoryId) || !body.regime) return NextResponse.json({ error: 'invalid assignment' }, { status: 422 })
  const categoryId = body.categoryId
  const regime = (await db.execute<{ class_attribute: string }>(sql`
    select class_attribute from tax_regimes where org_id=${gate.user.orgId} and code=${body.regime} and is_active limit 1`))
  const attribute = regime.rows[0]?.class_attribute
  if (!attribute) return NextResponse.json({ error: 'regime is not installed' }, { status: 422 })
  if (body.classCode) {
    const classRow = (await db.execute(sql`
      select 1 from tax_pool_classes where org_id=${gate.user.orgId} and regime=${body.regime} and class_code=${body.classCode} and is_active`))
    if (!classRow.rows[0]) return NextResponse.json({ error: 'invalid class' }, { status: 422 })
  }
  // Snapshot and write in ONE transaction so the audit row can never describe
  // a state that did not commit: a category's tax attributes decide how its
  // assets are reported on every filing.
  let notFound = false
  let openPoolClass: string | null = null
  await db.transaction(async (tx) => {
    // Tax-pool runs take this subsidiary fence before reading category class
    // assignments. Resolve all current subsidiary scopes and hold the same
    // fence through the audit and category update so a run cannot commit a
    // year using the previous class. Re-scan after acquiring each fence to
    // include subsidiaries that gained an asset while this transaction began.
    await lockAssetCategoryTaxLifecycle(tx, gate.user.orgId, categoryId)
    const before = (await tx.execute(sql`
      select * from asset_categories where id=${categoryId} and org_id=${gate.user.orgId} for update`))
    if (!before.rows[0]) {
      notFound = true
      return
    }
    const previousAttributes = (before.rows[0] as { tax_attributes?: Record<string, unknown> }).tax_attributes ?? {}
    const previousClass = typeof previousAttributes[attribute] === 'string' ? previousAttributes[attribute] : null
    if (previousClass && previousClass !== (body.classCode ?? null)) {
      const openPool = (await tx.execute<{ class_code: string }>(sql`
        select tp.class_code
          from fixed_assets a
          join asset_categories c on c.id = a.category_id and c.org_id = a.org_id
          join tax_depreciation_pools tp
            on tp.org_id = a.org_id and tp.subsidiary_id = a.subsidiary_id
           and tp.regime = ${body.regime} and tp.class_code = c.tax_attributes->>${attribute}
          join lateral (
            select pp.closing_balance
              from tax_pool_periods pp
             where pp.org_id = tp.org_id and pp.pool_id = tp.id
             order by pp.tax_year desc
             limit 1
          ) latest on true
         where a.org_id = ${gate.user.orgId} and a.category_id = ${categoryId}
           and latest.closing_balance <> 0
         limit 1`)).rows[0]
      if (openPool) {
        openPoolClass = openPool.class_code
        return
      }
    }
    const after = body.classCode
      ? await tx.execute(sql`
          update asset_categories
             set tax_attributes=jsonb_set(tax_attributes, array[${attribute}], to_jsonb(${body.classCode}::text), true),
                 updated_at=now(), updated_by=${gate.user.id}
           where id=${categoryId} and org_id=${gate.user.orgId} returning *`)
      : await tx.execute(sql`
          update asset_categories set tax_attributes=tax_attributes-${attribute}, updated_at=now(), updated_by=${gate.user.id}
           where id=${categoryId} and org_id=${gate.user.orgId} returning *`)
    const beforeRow = (before.rows[0] ?? null) as Record<string, unknown> | null
    const afterRow = (after.rows[0] ?? null) as Record<string, unknown> | null
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id)
      values
         (${gate.user.orgId}, 'asset_categories', ${String(categoryId)}, 'update',
         ${JSON.stringify({
           before: beforeRow,
           after: afterRow,
           regime: body.regime,
           classCode: body.classCode ?? null,
         })}::jsonb,
         ${gate.user.id})
    `)
  })
  if (notFound) return NextResponse.json({ error: 'category not found' }, { status: 404 })
  if (openPoolClass) {
    return NextResponse.json(
      { error: `cannot remove tax class "${openPoolClass}" while its pool has a nonzero balance; keep or restore this class assignment until the pool is closed` },
      { status: 422 },
    )
  }
  return NextResponse.json({ ok: true })
}
