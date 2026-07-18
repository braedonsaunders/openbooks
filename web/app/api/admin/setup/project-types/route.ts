import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'

export const runtime = 'nodejs'

/** Create / update / archive a project type. The three profile jsonb blobs are
 *  stored as-provided (shape is TS-typed at the edit surface). */
export async function POST(req: Request) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const orgId = gate.user.orgId
  const b = (await req.json().catch(() => ({}))) as any
  const key = String(b.key ?? '').trim()
  const name = String(b.name ?? '').trim()
  if (!key || !name) return NextResponse.json({ error: 'Key and name are required' }, { status: 422 })
  if (!b.financialProfile || !b.invoicingProfile || !b.backupProfile)
    return NextResponse.json({ error: 'Missing profile' }, { status: 422 })
  try {
    const r = (await db.execute(sql`
      insert into project_types (org_id, key, name, description, is_built_in, is_active, sort_order,
        billing_method, financial_profile, invoicing_profile, backup_profile, created_by, updated_by)
      values (${orgId}, ${key}, ${name}, ${b.description ?? null}, false, true, ${Number(b.sortOrder ?? 50)},
        ${b.billingMethod ?? null}, ${JSON.stringify(b.financialProfile)}::jsonb,
        ${JSON.stringify(b.invoicingProfile)}::jsonb, ${JSON.stringify(b.backupProfile)}::jsonb,
        ${gate.user.id}, ${gate.user.id})
      returning id`)) as unknown as { rows: { id: string }[] }
    return NextResponse.json({ id: r.rows[0].id })
  } catch (e) {
    const msg = (e as Error).message
    if (/unique|duplicate/i.test(msg)) return NextResponse.json({ error: 'A type with that key already exists' }, { status: 409 })
    return NextResponse.json({ error: msg }, { status: 422 })
  }
}

export async function PATCH(req: Request) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const orgId = gate.user.orgId
  const b = (await req.json().catch(() => ({}))) as any
  if (!isUuid(b.id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const sets = [
    sql`name = ${String(b.name ?? '').trim()}`,
    sql`description = ${b.description ?? null}`,
    sql`is_active = ${b.isActive !== false}`,
    sql`sort_order = ${Number(b.sortOrder ?? 50)}`,
    sql`billing_method = ${b.billingMethod ?? null}`,
    sql`updated_at = now()`,
    sql`updated_by = ${gate.user.id}`,
  ]
  if (b.financialProfile) sets.push(sql`financial_profile = ${JSON.stringify(b.financialProfile)}::jsonb`)
  if (b.invoicingProfile) sets.push(sql`invoicing_profile = ${JSON.stringify(b.invoicingProfile)}::jsonb`)
  if (b.backupProfile) sets.push(sql`backup_profile = ${JSON.stringify(b.backupProfile)}::jsonb`)
  await db.execute(sql`update project_types set ${sql.join(sets, sql`, `)} where id = ${b.id} and org_id = ${orgId}`)
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: Request) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const orgId = gate.user.orgId
  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  if (!id || !isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  // Built-in types archive (is_active=false); custom types with no projects delete.
  const inUse = (await db.execute(sql`select 1 from projects where project_type_id = ${id} and org_id = ${orgId} limit 1`)) as unknown as { rows: unknown[] }
  const builtIn = (await db.execute(sql`select is_built_in from project_types where id = ${id} and org_id = ${orgId}`)) as unknown as { rows: { is_built_in: boolean }[] }
  if (builtIn.rows[0]?.is_built_in || inUse.rows.length > 0) {
    await db.execute(sql`update project_types set is_active = false, updated_at = now(), updated_by = ${gate.user.id} where id = ${id} and org_id = ${orgId}`)
    return NextResponse.json({ ok: true, archived: true })
  }
  await db.execute(sql`delete from project_types where id = ${id} and org_id = ${orgId}`)
  return NextResponse.json({ ok: true })
}
