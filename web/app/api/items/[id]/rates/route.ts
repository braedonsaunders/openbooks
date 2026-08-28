import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { cmp, normalizeMoney } from '@openbooks/engine/src/money.ts'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
import { isFeatureEnabled } from '../../../../../lib/features'
import { isUuid } from '../../../../../lib/list-params'
import { canonicalDecimal } from '../../../../../lib/exact-decimal'

export const runtime = 'nodejs'

const INVENTORY_ITEM_KINDS = new Set(['inventory', 'assembly', 'kit'])
const POLICIES = ['capped_ladder', 'lowest_cost'] as const
const PRESENTATIONS = ['summary', 'rate_components'] as const

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('items.read', 'projects')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const item = ((await db.execute(sql`select 1 from items where id = ${id} and org_id = ${gate.user.orgId}`)))
  if (!item.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const [books, profile, versions, timeTypes] = await Promise.all([
    (db.execute(sql`select id, code, name, currency, is_default from item_rate_books where org_id = ${gate.user.orgId} and is_active order by is_default desc, name`)),
    (db.execute(sql`select base_unit, pricing_policy, invoice_presentation from item_rate_profiles where org_id = ${gate.user.orgId} and item_id = ${id}`)),
    (db.execute(sql`
      select v.id, v.rate_book_id, b.name as rate_book_name, v.effective_from, v.effective_to, v.status,
             coalesce(jsonb_agg(jsonb_build_object(
               'id', l.id, 'unitCode', l.unit_code, 'unitName', l.unit_name, 'baseQuantity', l.base_quantity,
               'costRate', l.cost_rate, 'billRate', l.bill_rate, 'sortOrder', l.sort_order,
               'timeTypeBillRates', l.time_type_bill_rates
             ) order by l.base_quantity) filter (where l.id is not null), '[]'::jsonb) as tiers
        from item_rate_versions v
        join item_rate_books b on b.id = v.rate_book_id and b.org_id = v.org_id
        join item_rate_lines l on l.version_id = v.id and l.item_id = ${id} and l.org_id = v.org_id
       where v.org_id = ${gate.user.orgId}
       group by v.id, b.name
       order by v.effective_from desc
    `)),
    (db.execute(sql`select id, name, bill_multiplier from time_types where org_id = ${gate.user.orgId} and is_active order by bill_multiplier, name`)),
  ])
  return NextResponse.json({ books: books.rows, profile: profile.rows[0] ?? null, versions: versions.rows, timeTypes: timeTypes.rows })
}

interface TierInput { unitCode?: string; unitName?: string; baseQuantity?: string; costRate?: string; billRate?: string; timeTypeBillRates?: Record<string, string> }

/** Keep only uuid → non-negative numeric entries (explicit per-time-type bill rates). */
function cleanTierRates(input: Record<string, string> | undefined): string {
  const out: Record<string, string> = {}
  if (input && typeof input === 'object') {
    for (const [k, v] of Object.entries(input)) {
      if (isUuid(k) && v !== '') {
        const exact = canonicalDecimal(v, 4)
        if (exact !== null && cmp(exact, '0') >= 0) out[k] = normalizeMoney(exact)
      }
    }
  }
  return JSON.stringify(out)
}


export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('items.manage', 'projects')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  // Stored rate lines stay. Turning Inventory off must 404 a save that would
  // persist new rates on an inventory / assembly / kit item.
  if (!(await isFeatureEnabled(gate.user.orgId, 'inventory'))) {
    const existing = (await db.execute<{ kind: string }>(sql`
      select kind from items where id = ${id} and org_id = ${gate.user.orgId}`))
    if (existing.rows[0] && INVENTORY_ITEM_KINDS.has(existing.rows[0].kind)) {
      return NextResponse.json({ error: 'not found' }, { status: 404 })
    }
  }
  // Stored rate lines stay. Turning Equipment off must 404 a save that would
  // persist new rates on an equipment_charge item.
  if (!(await isFeatureEnabled(gate.user.orgId, 'equipment'))) {
    const existing = (await db.execute<{ kind: string }>(sql`
      select kind from items where id = ${id} and org_id = ${gate.user.orgId}`))
    if (existing.rows[0] && existing.rows[0].kind === 'equipment_charge') {
      return NextResponse.json({ error: 'not found' }, { status: 404 })
    }
  }
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as {
    rateBookId?: string | null; effectiveFrom?: string; baseUnit?: string;
    pricingPolicy?: string; invoicePresentation?: string; tiers?: TierInput[]
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.effectiveFrom ?? '')) return NextResponse.json({ error: 'Effective date is required' }, { status: 422 })
  if (!body.baseUnit?.trim()) return NextResponse.json({ error: 'Base unit is required' }, { status: 422 })
  if (!POLICIES.includes(body.pricingPolicy as unknown as "capped_ladder" | "lowest_cost")) return NextResponse.json({ error: 'Invalid pricing policy' }, { status: 422 })
  if (!PRESENTATIONS.includes((body.invoicePresentation ?? 'rate_components') as unknown as "summary" | "rate_components")) return NextResponse.json({ error: 'Invalid invoice presentation' }, { status: 422 })
  if (!Array.isArray(body.tiers) || body.tiers.length === 0) return NextResponse.json({ error: 'Add at least one rate unit' }, { status: 422 })
  const baseUnit = body.baseUnit.trim()
  const tiers: Array<TierInput & { baseQuantity: string; costRate: string; billRate: string }> = []
  const seen = new Set<string>()
  for (const tier of body.tiers) {
    const code = tier.unitCode?.trim().toLowerCase()
    if (!code || !tier.unitName?.trim()) return NextResponse.json({ error: 'Every rate unit needs a code and name' }, { status: 422 })
    if (seen.has(code)) return NextResponse.json({ error: 'Rate unit codes must be unique' }, { status: 422 })
    seen.add(code)
    const baseQuantity = canonicalDecimal(tier.baseQuantity, 8)
    const costRate = canonicalDecimal(tier.costRate, 4)
    const billRate = canonicalDecimal(tier.billRate, 4)
    if (baseQuantity === null || costRate === null || billRate === null) {
      return NextResponse.json({ error: 'Quantities must be positive and rates must be non-negative numbers' }, { status: 422 })
    }
    try {
      if (cmp(baseQuantity, '0') <= 0) throw new Error()
      if (cmp(costRate, '0') < 0 || cmp(billRate, '0') < 0) throw new Error()
    } catch {
      return NextResponse.json({ error: 'Quantities must be positive and rates must be non-negative numbers' }, { status: 422 })
    }
    tiers.push({
      ...tier,
      unitCode: code,
      unitName: tier.unitName.trim(),
      baseQuantity,
      costRate: normalizeMoney(costRate),
      billRate: normalizeMoney(billRate),
    })
  }

  try {
    const result = await db.transaction(async (tx) => {
      const item = ((await tx.execute(sql`select 1 from items where id = ${id} and org_id = ${gate.user.orgId}`)))
      if (!item.rows[0]) throw new Error('Item not found')
      // First version creation must serialize with rate-book currency edits:
      // take the same advisory fence and row lock the Setup writer takes,
      // before this transaction reads the book. A concurrent currency PATCH
      // then either commits before the book is read here, or waits for this
      // version to become visible and is rejected by rate_book_currency_guard.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`item-rate-books:${gate.user.orgId}`}, 0))`)
      let rateBookId = body.rateBookId
      if (rateBookId) {
        const book = ((await tx.execute(sql`select 1 from item_rate_books where id = ${rateBookId} and org_id = ${gate.user.orgId} and is_active for update`)))
        if (!book.rows[0]) throw new Error('Rate book not found')
      } else {
        const existing = (await tx.execute(sql`select id from item_rate_books where org_id = ${gate.user.orgId} and is_default and is_active limit 1 for update`)) as any
        rateBookId = existing.rows[0]?.id
        if (!rateBookId) {
          const org = ((await tx.execute(sql`select base_currency from orgs where id = ${gate.user.orgId}`)))
          const created = (await tx.execute(sql`
            insert into item_rate_books (org_id, code, name, currency, is_default, created_by, updated_by)
            values (${gate.user.orgId}, 'STANDARD', 'Standard', ${org.rows[0]?.base_currency ?? 'CAD'}, true, ${gate.user.id}, ${gate.user.id}) returning id
          `)) as any
          rateBookId = created.rows[0].id
        }
      }
      const duplicate = ((await tx.execute(sql`select 1 from item_rate_versions where org_id = ${gate.user.orgId} and rate_book_id = ${rateBookId} and effective_from = ${body.effectiveFrom}`)))
      if (duplicate.rows[0]) throw new Error('A rate version already starts on that date')
      const nextVersion = ((await tx.execute(sql`
        select effective_from from item_rate_versions
         where org_id = ${gate.user.orgId} and rate_book_id = ${rateBookId} and effective_from > ${body.effectiveFrom}
         order by effective_from limit 1
      `)))
      // Versions are snapshots for the whole rate book, not just this item.
      // Keep the latest earlier snapshot so changing one item does not erase
      // every other item's rates from the replacement version.
      const previousVersion = ((await tx.execute<{ id: string }>(sql`
        select id from item_rate_versions
         where org_id = ${gate.user.orgId} and rate_book_id = ${rateBookId}
           and effective_from < ${body.effectiveFrom} and status = 'active'
         order by effective_from desc limit 1
      `)))
      await tx.execute(sql`
        insert into item_rate_profiles (org_id, item_id, base_unit, pricing_policy, invoice_presentation, created_by, updated_by)
        values (${gate.user.orgId}, ${id}, ${baseUnit}, ${body.pricingPolicy}, ${body.invoicePresentation ?? 'rate_components'}, ${gate.user.id}, ${gate.user.id})
        on conflict (org_id, item_id) do update set base_unit = excluded.base_unit, pricing_policy = excluded.pricing_policy,
          invoice_presentation = excluded.invoice_presentation, is_active = true, updated_at = now(), updated_by = excluded.updated_by
        where item_rate_profiles.org_id = ${gate.user.orgId}
      `)
      await tx.execute(sql`
        update item_rate_versions set effective_to = (${body.effectiveFrom}::date - interval '1 day')::date, updated_at = now(), updated_by = ${gate.user.id}
         where org_id = ${gate.user.orgId} and rate_book_id = ${rateBookId} and effective_from < ${body.effectiveFrom}
           and (effective_to is null or effective_to >= ${body.effectiveFrom})
      `)
      const version = (await tx.execute(sql`
        insert into item_rate_versions (org_id, rate_book_id, effective_from, effective_to, status, created_by, updated_by)
        values (${gate.user.orgId}, ${rateBookId}, ${body.effectiveFrom},
                ${nextVersion.rows[0]?.effective_from ? sql`(${nextVersion.rows[0].effective_from}::date - interval '1 day')::date` : null},
                'draft', ${gate.user.id}, ${gate.user.id}) returning id
      `)) as any
      if (previousVersion.rows[0]?.id) {
        await tx.execute(sql`
          insert into item_rate_lines (
            org_id, version_id, item_id, unit_code, unit_name, base_quantity,
            cost_rate, bill_rate, time_type_bill_rates, sort_order, created_by, updated_by
          )
          select org_id, ${version.rows[0].id}, item_id, unit_code, unit_name, base_quantity,
                 cost_rate, bill_rate, time_type_bill_rates, sort_order, ${gate.user.id}, ${gate.user.id}
            from item_rate_lines
           where org_id = ${gate.user.orgId} and version_id = ${previousVersion.rows[0].id}
             and item_id <> ${id}
        `)
      }
      let sort = 0
      for (const tier of tiers) {
        await tx.execute(sql`
          insert into item_rate_lines (org_id, version_id, item_id, unit_code, unit_name, base_quantity, cost_rate, bill_rate, time_type_bill_rates, sort_order, created_by, updated_by)
          values (${gate.user.orgId}, ${version.rows[0].id}, ${id}, ${tier.unitCode}, ${tier.unitName},
                  ${tier.baseQuantity}, ${tier.costRate}, ${tier.billRate}, ${cleanTierRates(tier.timeTypeBillRates)}::jsonb, ${sort++}, ${gate.user.id}, ${gate.user.id})
        `)
      }
      await tx.execute(sql`
        update item_rate_versions set status = 'active', updated_at = now(), updated_by = ${gate.user.id}
         where id = ${version.rows[0].id} and org_id = ${gate.user.orgId}
      `)
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
