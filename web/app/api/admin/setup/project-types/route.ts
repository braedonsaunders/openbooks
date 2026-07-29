import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { publishProjectFinancialProfileInTransaction } from '@openbooks/engine/src/project-financial-profile-versions.ts'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { guardProjectsFeature } from '../../../../../lib/projects-gate'
import { isFeatureEnabled } from '../../../../../lib/features'

export const runtime = 'nodejs'

function validateInvoicingProfile(profile: any, billingMethod: unknown): string | null {
  const validBases = new Set(['date_range', 'draw_amount', 'time_selection', 'milestone', 'field_ticket'])
  const procedure = profile?.billingProcedure ?? 'standard'
  if (!['standard', 'application_for_payment'].includes(procedure)) return 'Invalid billing procedure'
  if (!Array.isArray(profile?.allowedBases) || profile.allowedBases.length === 0) return 'At least one billing basis is required'
  if (profile.allowedBases.some((basis: unknown) => typeof basis !== 'string' || !validBases.has(basis))) {
    return 'Invalid billing basis'
  }
  if (new Set(profile.allowedBases).size !== profile.allowedBases.length) return 'Billing bases must be unique'
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

/** Create / update / archive a project type. Financial policy is published as
 * an append-only effective-dated version; the other profiles remain ordinary
 * audited setup because they do not reinterpret historical profitability. */
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
  if (
    b.invoicingProfile.allowedBases.includes('field_ticket')
    && !(await isFeatureEnabled(orgId, 'fieldTickets'))
  ) {
    return NextResponse.json(
      { error: 'Enable Field Tickets in Company Settings → Features before adding Field Ticket billing' },
      { status: 422 },
    )
  }
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
      await publishProjectFinancialProfileInTransaction(tx, {
        orgId,
        projectTypeId: createdId,
        effectiveFrom: new Date().toISOString().slice(0, 10),
        financialProfile: b.financialProfile,
        reason: 'Initial project type financial policy',
        actorId: gate.user.id,
      })
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
  const fieldTicketsEnabled = b.invoicingProfile
    ? await isFeatureEnabled(orgId, 'fieldTickets')
    : false
  const sets = [
    sql`name = ${String(b.name ?? '').trim()}`,
    sql`description = ${b.description ?? null}`,
    sql`is_active = ${b.isActive !== false}`,
    sql`sort_order = ${Number(b.sortOrder ?? 50)}`,
    sql`billing_method = ${b.billingMethod ?? null}`,
    sql`updated_at = now()`,
    sql`updated_by = ${gate.user.id}`,
  ]
  if (b.invoicingProfile) sets.push(sql`invoicing_profile = ${JSON.stringify(b.invoicingProfile)}::jsonb`)
  if (b.backupProfile) sets.push(sql`backup_profile = ${JSON.stringify(b.backupProfile)}::jsonb`)
  let updated: boolean
  try {
    updated = await db.transaction(async (tx) => {
      const before = (await tx.execute(sql`
        select pt.key, pt.name, pt.description, pt.is_active, pt.sort_order,
               pt.billing_method, pt.invoicing_profile, pt.backup_profile,
               coalesce(version.financial_profile, pt.financial_profile) as financial_profile
          from project_types pt
          left join lateral (
            select v.financial_profile
              from project_financial_profile_versions v
             where v.org_id = pt.org_id
               and v.project_type_id = pt.id
               and v.effective_from <= current_date
               and (v.effective_to is null or v.effective_to >= current_date)
             order by v.effective_from desc
             limit 1
          ) version on true
         where pt.id = ${b.id} and pt.org_id = ${orgId}
         for update of pt
      `)) as unknown as { rows: (Record<string, unknown> & { financial_profile: unknown })[] }
      if (!before.rows[0]) return false
      const beforeInvoicing = before.rows[0].invoicing_profile as { allowedBases?: string[] } | null
      if (
        b.invoicingProfile?.allowedBases?.includes('field_ticket')
        && !fieldTicketsEnabled
        && !beforeInvoicing?.allowedBases?.includes('field_ticket')
      ) {
        throw new Error('Enable Field Tickets in Company Settings → Features before adding Field Ticket billing')
      }

      let financialVersion: { id: string; effectiveFrom: string; effectiveTo: string | null } | null = null
      if (b.financialProfile) {
        const comparison = (await tx.execute(sql`
          select ${JSON.stringify(b.financialProfile)}::jsonb
                 is distinct from
                 ${JSON.stringify(before.rows[0].financial_profile)}::jsonb as changed
        `)) as unknown as { rows: { changed: boolean }[] }
        if (comparison.rows[0]?.changed) {
          financialVersion = await publishProjectFinancialProfileInTransaction(tx, {
            orgId,
            projectTypeId: b.id,
            effectiveFrom: String(b.financialEffectiveFrom ?? ''),
            financialProfile: b.financialProfile,
            reason: String(b.financialChangeReason ?? ''),
            actorId: gate.user.id,
          })
        }
      }

      const after = (await tx.execute(sql`
        update project_types set ${sql.join(sets, sql`, `)}
         where id = ${b.id} and org_id = ${orgId}
         returning key, name, description, is_active, sort_order, billing_method,
                   invoicing_profile, backup_profile
      `)) as unknown as { rows: Record<string, unknown>[] }
      const projectTypeBefore = { ...before.rows[0] }
      delete projectTypeBefore.financial_profile
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'project_types', ${b.id}, 'update',
                ${JSON.stringify({
                  before: projectTypeBefore,
                  after: after.rows[0],
                  ...(financialVersion ? { financialProfileVersion: financialVersion } : {}),
                })},
                ${gate.user.id})`)
      return true
    })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 422 })
  }
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
  // Once a financial policy exists the project type is accounting configuration.
  // Archive it; do not erase the type or its policy history even if unused.
  const result = await db.transaction(async (tx) => {
    const before = (await tx.execute(sql`
      select * from project_types where id = ${id} and org_id = ${orgId} for update
    `)) as unknown as { rows: Record<string, unknown>[] }
    if (!before.rows[0]) return null
    await tx.execute(sql`update project_types set is_active = false, updated_at = now(), updated_by = ${gate.user.id} where id = ${id} and org_id = ${orgId}`)
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'project_types', ${id}, 'archive',
              ${JSON.stringify({ before: before.rows[0] })}, ${gate.user.id})`)
    return true
  })
  if (result === null) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ ok: true, archived: true })
}
