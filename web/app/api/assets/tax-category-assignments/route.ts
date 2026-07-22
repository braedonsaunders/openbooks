import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'

export const runtime = 'nodejs'

export async function PATCH(req: Request) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const body = (await req.json().catch(() => ({}))) as { categoryId?: string; regime?: string; classCode?: string | null }
  if (!body.categoryId || !isUuid(body.categoryId) || !body.regime) return NextResponse.json({ error: 'invalid assignment' }, { status: 422 })
  const regime = (await db.execute(sql`
    select class_attribute from tax_regimes where org_id=${gate.user.orgId} and code=${body.regime} and is_active limit 1`)) as unknown as { rows: { class_attribute: string }[] }
  const attribute = regime.rows[0]?.class_attribute
  if (!attribute) return NextResponse.json({ error: 'regime is not installed' }, { status: 422 })
  if (body.classCode) {
    const classRow = (await db.execute(sql`
      select 1 from tax_pool_classes where org_id=${gate.user.orgId} and regime=${body.regime} and class_code=${body.classCode} and is_active`)) as unknown as { rows: unknown[] }
    if (!classRow.rows[0]) return NextResponse.json({ error: 'invalid class' }, { status: 422 })
  }
  const result = body.classCode
    ? await db.execute(sql`
        update asset_categories
           set tax_attributes=jsonb_set(tax_attributes, array[${attribute}], to_jsonb(${body.classCode}::text), true),
               updated_at=now(), updated_by=${gate.user.id}
         where id=${body.categoryId} and org_id=${gate.user.orgId} returning id`)
    : await db.execute(sql`
        update asset_categories set tax_attributes=tax_attributes-${attribute}, updated_at=now(), updated_by=${gate.user.id}
         where id=${body.categoryId} and org_id=${gate.user.orgId} returning id`)
  if (!(result as unknown as { rows: unknown[] }).rows[0]) return NextResponse.json({ error: 'category not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
