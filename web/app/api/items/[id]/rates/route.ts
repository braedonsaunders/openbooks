import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { cmp } from '@openbooks/engine/src/money.ts'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'

export const runtime = 'nodejs'

const POLICIES = ['capped_ladder', 'lowest_cost'] as const
const PRESENTATIONS = ['summary', 'rate_components'] as const

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('items.read')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const item = (await db.execute(sql`select 1 from items where id = ${id} and org_id = ${gate.user.orgId}`)) as any
  if (!item.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const [books, profile, versions] = await Promise.all([
    db.execute(sql`select id, code, name, currency, is_default from item_rate_books where org_id = ${gate.user.orgId} and is_active order by is_default desc, name`) as any,
    db.execute(sql`select base_unit, pricing_policy, invoice_presentation from item_rate_profiles where org_id = ${gate.user.orgId} and item_id = ${id}`) as any,
    db.execute(sql`
      select v.id, v.rate_book_id, b.name as rate_book_name, v.effective_from, v.effective_to, v.status,
             coalesce(jsonb_agg(jsonb_build_object(
               'id', l.id, 'unitCode', l.unit_code, 'unitName', l.unit_name, 'baseQuantity', l.base_quantity,
               'costRate', l.cost_rate, 'billRate', l.bill_rate, 'sortOrder', l.sort_order
             ) order by l.base_quantity) filter (where l.id is not null), '[]'::jsonb) as tiers
        from item_rate_versions v
        join item_rate_books b on b.id = v.rate_book_id
        join item_rate_lines l on l.version_id = v.id and l.item_id = ${id}
       where v.org_id = ${gate.user.orgId}
       group by v.id, b.name
       order by v.effective_from desc
    `) as any,
  ])
  return NextResponse.json({ books: books.rows, profile: profile.rows[0] ?? null, versions: versions.rows })
}

interface TierInput { unitCode?: string; unitName?: string; baseQuantity?: string; costRate?: string; billRate?: string }

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('items.manage')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const body = await req.json() as {
    rateBookId?: string | null; effectiveFrom?: string; baseUnit?: string;
    pricingPolicy?: string; invoicePresentation?: string; tiers?: TierInput[]
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.effectiveFrom ?? '')) return NextResponse.json({ error: 'Effective date is required' }, { status: 422 })
  if (!body.baseUnit?.trim()) return NextResponse.json({ error: 'Base unit is required' }, { status: 422 })
  if (!POLICIES.includes(body.pricingPolicy as any)) return NextResponse.json({ error: 'Invalid pricing policy' }, { status: 422 })
  if (!PRESENTATIONS.includes((body.invoicePresentation ?? 'rate_components') as any)) return NextResponse.json({ error: 'Invalid invoice presentation' }, { status: 422 })
  if (!Array.isArray(body.tiers) || body.tiers.length === 0) return NextResponse.json({ error: 'Add at least one rate unit' }, { status: 422 })
  const baseUnit = body.baseUnit.trim()
  const tiers = body.tiers
  const seen = new Set<string>()
  for (const tier of body.tiers) {
    const code = tier.unitCode?.trim().toLowerCase()
    if (!code || !tier.unitName?.trim()) return NextResponse.json({ error: 'Every rate unit needs a code and name' }, { status: 422 })
    if (seen.has(code)) return NextResponse.json({ error: 'Rate unit codes must be unique' }, { status: 422 })
    seen.add(code)
    try {
      if (cmp(String(tier.baseQuantity ?? ''), '0') <= 0) throw new Error()
      if (cmp(String(tier.costRate ?? ''), '0') < 0 || cmp(String(tier.billRate ?? ''), '0') < 0) throw new Error()
    } catch {
      return NextResponse.json({ error: 'Quantities must be positive and rates must be non-negative numbers' }, { status: 422 })
    }
  }

  try {
    const result = await db.transaction(async (tx) => {
      const item = (await tx.execute(sql`select 1 from items where id = ${id} and org_id = ${gate.user.orgId}`)) as any
      if (!item.rows[0]) throw new Error('Item not found')
      let rateBookId = body.rateBookId
      if (rateBookId) {
        const book = (await tx.execute(sql`select 1 from item_rate_books where id = ${rateBookId} and org_id = ${gate.user.orgId} and is_active`)) as any
        if (!book.rows[0]) throw new Error('Rate book not found')
      } else {
        const existing = (await tx.execute(sql`select id from item_rate_books where org_id = ${gate.user.orgId} and is_default and is_active limit 1`)) as any
        rateBookId = existing.rows[0]?.id
        if (!rateBookId) {
          const org = (await tx.execute(sql`select base_currency from orgs where id = ${gate.user.orgId}`)) as any
          const created = (await tx.execute(sql`
            insert into item_rate_books (org_id, code, name, currency, is_default, created_by, updated_by)
            values (${gate.user.orgId}, 'STANDARD', 'Standard', ${org.rows[0]?.base_currency ?? 'CAD'}, true, ${gate.user.id}, ${gate.user.id}) returning id
          `)) as any
          rateBookId = created.rows[0].id
        }
      }
      const duplicate = (await tx.execute(sql`select 1 from item_rate_versions where rate_book_id = ${rateBookId} and effective_from = ${body.effectiveFrom}`)) as any
      if (duplicate.rows[0]) throw new Error('A rate version already starts on that date')
      const nextVersion = (await tx.execute(sql`
        select effective_from from item_rate_versions
         where rate_book_id = ${rateBookId} and effective_from > ${body.effectiveFrom}
         order by effective_from limit 1
      `)) as any
      await tx.execute(sql`
        insert into item_rate_profiles (org_id, item_id, base_unit, pricing_policy, invoice_presentation, created_by, updated_by)
        values (${gate.user.orgId}, ${id}, ${baseUnit}, ${body.pricingPolicy}, ${body.invoicePresentation ?? 'rate_components'}, ${gate.user.id}, ${gate.user.id})
        on conflict (org_id, item_id) do update set base_unit = excluded.base_unit, pricing_policy = excluded.pricing_policy,
          invoice_presentation = excluded.invoice_presentation, is_active = true, updated_at = now(), updated_by = excluded.updated_by
      `)
      await tx.execute(sql`
        update item_rate_versions set effective_to = (${body.effectiveFrom}::date - interval '1 day')::date, updated_at = now(), updated_by = ${gate.user.id}
         where rate_book_id = ${rateBookId} and effective_from < ${body.effectiveFrom}
           and (effective_to is null or effective_to >= ${body.effectiveFrom})
      `)
      const version = (await tx.execute(sql`
        insert into item_rate_versions (org_id, rate_book_id, effective_from, effective_to, status, created_by, updated_by)
        values (${gate.user.orgId}, ${rateBookId}, ${body.effectiveFrom},
                ${nextVersion.rows[0]?.effective_from ? sql`(${nextVersion.rows[0].effective_from}::date - interval '1 day')::date` : null},
                'draft', ${gate.user.id}, ${gate.user.id}) returning id
      `)) as any
      let sort = 0
      for (const tier of tiers) {
        await tx.execute(sql`
          insert into item_rate_lines (org_id, version_id, item_id, unit_code, unit_name, base_quantity, cost_rate, bill_rate, sort_order, created_by, updated_by)
          values (${gate.user.orgId}, ${version.rows[0].id}, ${id}, ${tier.unitCode!.trim().toLowerCase()}, ${tier.unitName!.trim()},
                  ${tier.baseQuantity}, ${tier.costRate}, ${tier.billRate}, ${sort++}, ${gate.user.id}, ${gate.user.id})
        `)
      }
      await tx.execute(sql`
        update item_rate_versions set status = 'active', updated_at = now(), updated_by = ${gate.user.id}
         where id = ${version.rows[0].id} and org_id = ${gate.user.orgId} and status = 'draft'`)
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${gate.user.orgId}, 'item_rate_versions', ${version.rows[0].id}, 'insert',
                ${JSON.stringify({ itemId: id, rateBookId, effectiveFrom: body.effectiveFrom, baseUnit, pricingPolicy: body.pricingPolicy, invoicePresentation: body.invoicePresentation ?? 'rate_components', tiers })}::jsonb,
                ${gate.user.id})
      `)
      return { id: version.rows[0].id, rateBookId }
    })
    return NextResponse.json(result)
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not save rates' }, { status: 422 })
  }
}
