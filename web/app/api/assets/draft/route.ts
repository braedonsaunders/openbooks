import { NextRequest, NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { ensureDefaultCategory } from '../categories/_ensure'

export const runtime = 'nodejs'

/**
 * Instant-into-draft: create a draft fixed asset and return its id. The flyout
 * edits it in place; placing it in service requires real fields. A category is
 * required by the schema, so a default one is ensured up front.
 */
export async function POST(_req: NextRequest) {
  const gate = await guardFeaturePermission('assets.manage', 'fixedAssets')
  if (gate instanceof NextResponse) return gate
  const user = gate.user

  const categoryId = await ensureDefaultCategory(user.orgId, user.id)
  const root = (await db.execute<{ id: string }>(sql`
    select id from subsidiaries
     where org_id = ${user.orgId} and is_active and not is_elimination
       ${gate.allowedSubsidiaryIds ? sql`and id = any(${`{${[...gate.allowedSubsidiaryIds].join(',')}}`}::uuid[])` : sql``}
     order by (parent_id is null) desc, name limit 1`))
  if (!root.rows[0]) return NextResponse.json({ error: 'no_available_subsidiary' }, { status: 409 })

  // Next sequential FA-#### number (advisory; not uniquely constrained).
  const nextRes = (await db.execute<{ n: number }>(sql`
    select coalesce(max((regexp_replace(asset_number, '\\D', '', 'g'))::int), 0) + 1 as n
      from fixed_assets
     where org_id = ${user.orgId} and asset_number ~ '^FA-\\d+$'`))
  const seq = Number(nextRes.rows[0]?.n ?? 1)
  const assetNumber = `FA-${String(seq).padStart(4, '0')}`

  const ins = (await db.execute<{ id: string }>(sql`
    insert into fixed_assets
      (org_id, subsidiary_id, category_id, asset_number, name, status, acquisition_cost, salvage_value, created_by, updated_by)
    values (${user.orgId}, ${root.rows[0].id}, ${categoryId}, ${assetNumber}, 'New asset', 'draft', '0', '0', ${user.id}, ${user.id})
    returning id`))

  return NextResponse.json({ id: ins.rows[0].id })
}
