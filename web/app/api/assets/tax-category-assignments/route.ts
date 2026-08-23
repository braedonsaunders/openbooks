import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { isUuid } from '../../../../lib/list-params'

export const runtime = 'nodejs'

export async function PATCH(req: Request) {
  const gate = await guardFeaturePermission('admin.setup.manage', 'fixedAssets')
  if (gate instanceof NextResponse) return gate
  const body = (await req.json().catch(() => ({}))) as { categoryId?: string; regime?: string; classCode?: string | null }
  if (!body.categoryId || !isUuid(body.categoryId) || !body.regime) return NextResponse.json({ error: 'invalid assignment' }, { status: 422 })
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
  await db.transaction(async (tx) => {
    const before = (await tx.execute(sql`
      select * from asset_categories where id=${body.categoryId} and org_id=${gate.user.orgId}`))
    if (!before.rows[0]) {
      notFound = true
      return
    }
    const after = body.classCode
      ? await tx.execute(sql`
          update asset_categories
             set tax_attributes=jsonb_set(tax_attributes, array[${attribute}], to_jsonb(${body.classCode}::text), true),
                 updated_at=now(), updated_by=${gate.user.id}
           where id=${body.categoryId} and org_id=${gate.user.orgId} returning *`)
      : await tx.execute(sql`
          update asset_categories set tax_attributes=tax_attributes-${attribute}, updated_at=now(), updated_by=${gate.user.id}
           where id=${body.categoryId} and org_id=${gate.user.orgId} returning *`)
    const beforeRow = (before.rows[0] ?? null) as Record<string, unknown> | null
    const afterRow = (after.rows[0] ?? null) as Record<string, unknown> | null
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id)
      values
        (${gate.user.orgId}, 'asset_categories', ${String(body.categoryId)}, 'update',
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
  return NextResponse.json({ ok: true })
}
