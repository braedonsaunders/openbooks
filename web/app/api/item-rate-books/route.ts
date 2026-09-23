import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { isIsoCalendarDate } from '@openbooks/engine/src/platform/business-date.ts'
import { jsonObject, parseJsonBody } from '@/lib/api/json'
import { guardFeaturePermission } from '@/lib/feature-gates'
import { isFeatureEnabled } from '@/lib/features'
import { validateRateBookLines, type ValidRateBookLine } from '@/lib/item-rate-book-lines'
import { isUuid } from '@/lib/list-params'
import { saveSetupBook } from '@/lib/setup/books'
import { resolveSetupEntity } from '@/lib/setup/write'

export const runtime = 'nodejs'

const INVENTORY_KINDS = new Set(['inventory', 'assembly', 'kit'])

function databaseCode(error: unknown): string | undefined {
  const value = error as { code?: string; cause?: { code?: string } }
  return value.cause?.code ?? value.code
}

export async function POST(request: Request) {
  const gate = await guardFeaturePermission('admin.setup.manage', 'projects')
  if (gate instanceof NextResponse) return gate
  const parsed = await parseJsonBody(request, jsonObject)
  if (!parsed.ok) return parsed.response
  const body = parsed.data as Record<string, unknown>
  const id = body.id == null || body.id === '' ? null : String(body.id)
  if (id && !isUuid(id)) return NextResponse.json({ error: 'Rate book not found.' }, { status: 404 })
  const code = String(body.code ?? '').trim()
  const name = String(body.name ?? '').trim()
  if (!code) return NextResponse.json({ error: 'Code is required.' }, { status: 422 })
  if (!name) return NextResponse.json({ error: 'Name is required.' }, { status: 422 })

  const replaceRates = body.replaceRates === true
  const effectiveFrom = String(body.effectiveFrom ?? '')
  const validated = replaceRates ? validateRateBookLines(body.lines) : { lines: [] as ValidRateBookLine[] }
  if ('error' in validated) return NextResponse.json({ error: validated.error }, { status: 422 })
  if (replaceRates && !isIsoCalendarDate(effectiveFrom)) {
    return NextResponse.json({ error: 'Effective from must be a real calendar date in YYYY-MM-DD format.' }, { status: 422 })
  }
  // Activating a version with zero lines would silently wipe every rate in
  // the book from the new date. Refuse it unless the operator explicitly
  // confirmed clearing all rates; the check runs before the transaction, so
  // a refusal leaves the current active version untouched.
  if (replaceRates && validated.lines.length === 0 && body.confirmEmptyReplacement !== true) {
    return NextResponse.json({ error: `A replacement with no rate lines would clear every rate in this book from ${effectiveFrom}. Confirm that all rates should end, then save again.` }, { status: 422 })
  }

  const multiCurrency = await isFeatureEnabled(gate.user.orgId, 'multiCurrency')
  if (body.currency !== undefined && !multiCurrency) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const inventoryEnabled = await isFeatureEnabled(gate.user.orgId, 'inventory')
  const equipmentEnabled = await isFeatureEnabled(gate.user.orgId, 'equipment')
  const entity = resolveSetupEntity('item-rate-books')
  if (!entity) return NextResponse.json({ error: 'Rate book configuration is unavailable.' }, { status: 500 })

  try {
    const result = await db.transaction(async (tx) => {
      const bookId = await saveSetupBook(entity, gate.user.orgId, gate.user.id, {
        code, name,
        ...(body.currency !== undefined ? { currency: String(body.currency) } : {}),
        isDefault: body.isDefault === true,
        isActive: body.isActive !== false,
      }, tx, id ? { id } : {})
      if (!bookId) throw new Error('Rate book was not saved.')
      if (!replaceRates) return { id: bookId }

      const latest = (await tx.execute<{ id: string; effective_from: string }>(sql`
        select id, effective_from
          from item_rate_versions
         where org_id = ${gate.user.orgId} and rate_book_id = ${bookId} and status = 'active'
         order by effective_from desc
         limit 1
         for update`)).rows[0]
      if (latest && effectiveFrom <= String(latest.effective_from).slice(0, 10)) {
        throw new Error(`The new rate version must start after ${String(latest.effective_from).slice(0, 10)}. Choose a later effective date.`)
      }

      const itemIds = [...new Set(validated.lines.map((line) => line.itemId))]
      const itemRows = itemIds.length
        ? (await tx.execute<{ id: string; kind: string }>(sql`
            select id, kind from items
             where org_id = ${gate.user.orgId} and id in (${sql.join(itemIds.map((itemId) => sql`${itemId}`), sql`, `)})
             for update`)).rows
        : []
      if (itemRows.length !== itemIds.length) throw new Error('One or more selected items no longer exist in this organization. Remove them and save again.')
      const previousItemIds = latest
        ? new Set((await tx.execute<{ item_id: string }>(sql`
            select distinct item_id from item_rate_lines
             where org_id = ${gate.user.orgId} and version_id = ${latest.id}`)).rows.map((row) => String(row.item_id)))
        : new Set<string>()
      for (const item of itemRows) {
        if (!inventoryEnabled && INVENTORY_KINDS.has(item.kind) && !previousItemIds.has(String(item.id))) {
          throw new Error('Inventory must be enabled before adding an inventory, assembly, or kit item to a rate book.')
        }
        if (!equipmentEnabled && item.kind === 'equipment_charge' && !previousItemIds.has(String(item.id))) {
          throw new Error('Equipment must be enabled before adding an equipment-charge item to a rate book.')
        }
      }

      if (latest) {
        const closed = await tx.execute(sql`
          update item_rate_versions
             set effective_to = (${effectiveFrom}::date - interval '1 day')::date,
                 updated_at = now(), updated_by = ${gate.user.id}
           where id = ${latest.id} and org_id = ${gate.user.orgId} and status = 'active'
           returning id`)
        if (closed.rows.length !== 1) throw new Error('The current rate version changed while you were editing. Reload the rate book and try again.')
      }

      const version = (await tx.execute<{ id: string }>(sql`
        insert into item_rate_versions (org_id, rate_book_id, effective_from, status, created_by, updated_by)
        values (${gate.user.orgId}, ${bookId}, ${effectiveFrom}, 'draft', ${gate.user.id}, ${gate.user.id})
        returning id`)).rows[0]
      if (!version) throw new Error('The new rate version was not created.')

      const seenProfiles = new Set<string>()
      for (const line of validated.lines) {
        if (!seenProfiles.has(line.itemId)) {
          const profile = await tx.execute(sql`
            insert into item_rate_profiles (
              org_id, item_id, base_unit, pricing_policy, invoice_presentation, is_active, created_by, updated_by
            ) values (
              ${gate.user.orgId}, ${line.itemId}, ${line.baseUnit}, ${line.pricingPolicy}, ${line.invoicePresentation}, true, ${gate.user.id}, ${gate.user.id}
            )
            on conflict (org_id, item_id) do update
              set base_unit = excluded.base_unit,
                  pricing_policy = excluded.pricing_policy,
                  invoice_presentation = excluded.invoice_presentation,
                  is_active = true,
                  updated_at = now(),
                  updated_by = excluded.updated_by
              where item_rate_profiles.org_id = ${gate.user.orgId}
            returning id`)
          if (profile.rows.length !== 1) throw new Error('An item rate profile was not saved. Reload the rate book and try again.')
          // Pin this item's behavior to the new version. The profile row
          // above keeps only the defaults for future versions; resolution
          // reads this pin, so a later policy switch cannot reprice it.
          const pinned = await tx.execute(sql`
            insert into item_rate_version_profiles (org_id, version_id, item_id, base_unit, pricing_policy, invoice_presentation, created_by, updated_by)
            values (${gate.user.orgId}, ${version.id}, ${line.itemId}, ${line.baseUnit}, ${line.pricingPolicy}, ${line.invoicePresentation}, ${gate.user.id}, ${gate.user.id})
            returning id`)
          if (pinned.rows.length !== 1) throw new Error('An item rate profile pin was not saved. Reload the rate book and try again.')
          seenProfiles.add(line.itemId)
        }
        const inserted = await tx.execute(sql`
          insert into item_rate_lines (
            org_id, version_id, item_id, unit_code, unit_name, base_quantity,
            cost_rate, bill_rate, time_type_bill_rates, sort_order, created_by, updated_by
          ) values (
            ${gate.user.orgId}, ${version.id}, ${line.itemId}, ${line.unitCode}, ${line.unitName}, ${line.baseQuantity},
            ${line.costRate}, ${line.billRate}, ${JSON.stringify(line.timeTypeBillRates)}::jsonb,
            ${validated.lines.indexOf(line)}, ${gate.user.id}, ${gate.user.id}
          ) returning id`)
        if (inserted.rows.length !== 1) throw new Error('A rate line was not saved. Reload the rate book and try again.')
      }
      const activated = await tx.execute(sql`
        update item_rate_versions
           set status = 'active', updated_at = now(), updated_by = ${gate.user.id}
         where id = ${version.id} and org_id = ${gate.user.orgId} and status = 'draft'
         returning id`)
      if (activated.rows.length !== 1) throw new Error('The new rate version could not be activated. Reload the rate book and try again.')
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (
          ${gate.user.orgId}, 'item_rate_versions', ${version.id}, 'insert',
          ${JSON.stringify({ rateBookId: bookId, effectiveFrom, lineCount: validated.lines.length })}::jsonb,
          ${gate.user.id}
        )`)
      return { id: bookId, versionId: version.id }
    })
    return NextResponse.json(result)
  } catch (error) {
    const codeValue = databaseCode(error)
    if (codeValue === '23505') {
      return NextResponse.json({ error: 'That rate-book code or effective date is already in use. Choose a unique value.' }, { status: 409 })
    }
    if (codeValue === '23P01') {
      return NextResponse.json({ error: 'That effective date overlaps an active rate version. Choose a date after the current version.' }, { status: 409 })
    }
    const message = error instanceof Error ? error.message : 'The rate book could not be saved.'
    const status = message === 'not found' ? 404 : 422
    return NextResponse.json({ error: message === 'default-required' ? 'The default rate book must remain active and default. Make another active book the default first.' : message }, { status })
  }
}
