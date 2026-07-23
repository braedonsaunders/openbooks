import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { guardProjectsFeature } from '../../../../../lib/projects-gate'

export const runtime = 'nodejs'

function validateInvoicingProfile(profile: any, billingMethod: unknown): string | null {
  const procedure = profile?.billingProcedure ?? 'standard'
  if (!['standard', 'application_for_payment'].includes(procedure)) return 'Invalid billing procedure'
  if (!Array.isArray(profile?.allowedBases) || profile.allowedBases.length === 0) return 'At least one billing basis is required'
  if (!profile.allowedBases.includes(profile.defaultBasis)) return 'Default billing basis must be allowed'
  if (procedure === 'application_for_payment') {
    if (billingMethod !== 'fixed_price') return 'Applications for payment require the fixed-price compatibility classifier'
    if (profile.allowedBases.length !== 1 || profile.allowedBases[0] !== 'draw_amount') {
      return 'Applications for payment require draw-amount billing'
    }
    if (profile.defaultBasis !== 'draw_amount' || profile.lineBuilder !== 'draw') {
      return 'Applications for payment require the controlled draw line builder'
    }
  }
  return null
}

/** Create / update / archive a project type. The three profile jsonb blobs are
 *  stored as-provided (shape is TS-typed at the edit surface). */
export async function POST(req: Request) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const orgId = gate.user.orgId
  const feature = await guardProjectsFeature(orgId)
  if (feature) return feature
  const b = (await req.json().catch(() => ({}))) as any
  const key = String(b.key ?? '').trim()
  const name = String(b.name ?? '').trim()
  if (!key || !name) return NextResponse.json({ error: 'Key and name are required' }, { status: 422 })
  if (!b.financialProfile || !b.invoicingProfile || !b.backupProfile)
    return NextResponse.json({ error: 'Missing profile' }, { status: 422 })
  const profileError = validateInvoicingProfile(b.invoicingProfile, b.billingMethod)
  if (profileError) return NextResponse.json({ error: profileError }, { status: 422 })
  try {
    const id = await db.transaction(async (tx) => {
      const r = (await tx.execute(sql`
        insert into project_types (org_id, key, name, description, is_built_in, is_active, sort_order,
          billing_method, financial_profile, invoicing_profile, backup_profile, created_by, updated_by)
        values (${orgId}, ${key}, ${name}, ${b.description ?? null}, false, true, ${Number(b.sortOrder ?? 50)},
          ${b.billingMethod ?? null}, ${JSON.stringify(b.financialProfile)}::jsonb,
          ${JSON.stringify(b.invoicingProfile)}::jsonb, ${JSON.stringify(b.backupProfile)}::jsonb,
          ${gate.user.id}, ${gate.user.id})
        returning id`)) as unknown as { rows: { id: string }[] }
      const createdId = r.rows[0].id
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'project_types', ${createdId}, 'insert',
                ${JSON.stringify({ after: { key, name, billingMethod: b.billingMethod ?? null, financialProfile: b.financialProfile, invoicingProfile: b.invoicingProfile, backupProfile: b.backupProfile } })},
                ${gate.user.id})`)
      return createdId
    })
    return NextResponse.json({ id })
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
  const feature = await guardProjectsFeature(orgId)
  if (feature) return feature
  const b = (await req.json().catch(() => ({}))) as any
  if (!isUuid(b.id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (b.invoicingProfile) {
    const profileError = validateInvoicingProfile(b.invoicingProfile, b.billingMethod)
    if (profileError) return NextResponse.json({ error: profileError }, { status: 422 })
  }
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
  const updated = await db.transaction(async (tx) => {
    const before = (await tx.execute(sql`
      select key, name, description, is_active, sort_order, billing_method,
             financial_profile, invoicing_profile, backup_profile
        from project_types where id = ${b.id} and org_id = ${orgId} for update
    `)) as unknown as { rows: Record<string, unknown>[] }
    if (!before.rows[0]) return false
    const after = (await tx.execute(sql`
      update project_types set ${sql.join(sets, sql`, `)}
       where id = ${b.id} and org_id = ${orgId}
       returning key, name, description, is_active, sort_order, billing_method,
                 financial_profile, invoicing_profile, backup_profile
    `)) as unknown as { rows: Record<string, unknown>[] }
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'project_types', ${b.id}, 'update',
              ${JSON.stringify({ before: before.rows[0], after: after.rows[0] })}, ${gate.user.id})`)
    return true
  })
  if (!updated) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: Request) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const orgId = gate.user.orgId
  const feature = await guardProjectsFeature(orgId)
  if (feature) return feature
  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  if (!id || !isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  // Built-in types archive (is_active=false); custom types with no projects delete.
  const result = await db.transaction(async (tx) => {
    const before = (await tx.execute(sql`
      select * from project_types where id = ${id} and org_id = ${orgId} for update
    `)) as unknown as { rows: Record<string, unknown>[] }
    if (!before.rows[0]) return null
    const inUse = (await tx.execute(sql`select 1 from projects where project_type_id = ${id} and org_id = ${orgId} limit 1`)) as unknown as { rows: unknown[] }
    const archived = before.rows[0].is_built_in === true || inUse.rows.length > 0
    if (archived) {
      await tx.execute(sql`update project_types set is_active = false, updated_at = now(), updated_by = ${gate.user.id} where id = ${id} and org_id = ${orgId}`)
    } else {
      await tx.execute(sql`delete from project_types where id = ${id} and org_id = ${orgId}`)
    }
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'project_types', ${id}, ${archived ? 'archive' : 'delete'},
              ${JSON.stringify({ before: before.rows[0] })}, ${gate.user.id})`)
    return archived
  })
  if (result === null) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ ok: true, ...(result ? { archived: true } : {}) })
}
