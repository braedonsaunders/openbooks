import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// Only an approved (issued) purchase order converts: convertOrder used to
// reject only draft/voided, so a pending_approval order converted into a
// vendor bill before it was ever issued.
const root = pathToFileURL(process.cwd() + '/').href
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { convertOrder, ConversionError } = await import('../../../../../lib/order-cycle')
const DB = !!process.env.OPENBOOKS_DB_URL

test('convert refuses a pending_approval purchase order', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actor = randomUUID()
    await withBypassContext(() => db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{features}',
        coalesce(settings->'features', '{}'::jsonb) || '{"orders":true}'::jsonb)
      where id = ${org.orgId}`))
    const id = randomUUID()
    await withBypassContext(() => db.execute(sql`
      insert into documents (id, org_id, kind, document_number, subsidiary_id, document_date, currency, fx_rate, status, subtotal, tax_total, total)
      values (${id}, ${org.orgId}, 'purchase_order', ${'PO-' + id.slice(0, 8)}, ${org.subsidiaryId}, ${org.date}, 'CAD', 1, 'pending_approval', '0', '0', '0')`))
    const error = await withOrgContext(org.orgId, () =>
      convertOrder(org.orgId, actor, id, 'vendor_bill').then(
        () => null,
        (cause) => cause,
      ),
    )
    assert.ok(error instanceof ConversionError, `expected a ConversionError, got ${String(error)}`)
    assert.match(error.message, /pending_approval/)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('convert refuses equipment lines with a named remedy when Equipment is off', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actor = randomUUID()
    // Orders on, Equipment explicitly off (the registry default is on).
    await withBypassContext(() => db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{features}',
        coalesce(settings->'features', '{}'::jsonb) || '{"orders":true,"equipment":false}'::jsonb)
      where id = ${org.orgId}`))
    const itemId = randomUUID()
    await withBypassContext(() => db.execute(sql`
      insert into items (id, org_id, kind, code, name, default_cost, default_rate, expense_account_id, cost_recovery_account_id, income_account_id, is_active, custom)
      values (${itemId}, ${org.orgId}, 'equipment_charge', 'EXC', 'Excavator', '125.3750', '250.0000',
              ${org.accounts.cogs}, ${org.accounts.adjustment}, ${org.accounts.revenue}, true, '{}'::jsonb)`))
    const id = randomUUID()
    await withBypassContext(() => db.execute(sql`
      insert into documents (id, org_id, kind, document_number, subsidiary_id, document_date, currency, fx_rate, status, subtotal, tax_total, total)
      values (${id}, ${org.orgId}, 'purchase_order', ${'PO-' + id.slice(0, 8)}, ${org.subsidiaryId}, ${org.date}, 'CAD', 1, 'draft', '20', '0', '20')`))
    await withBypassContext(() => db.execute(sql`
      insert into document_lines (id, org_id, document_id, line_number, item_id, account_id, description, quantity, unit, unit_price, amount, tax_amount, quantity_fulfilled, quantity_billed, stock_location_id, custom)
      values (${randomUUID()}, ${org.orgId}, ${id}, 1, ${itemId}, ${org.accounts.cogs}, 'Excavator time',
              '2', 'ea', '10', '20', '0', '0', '0', ${org.stockLocationId}, '{}'::jsonb)`))
    await withBypassContext(() => db.execute(sql`
      update documents set status = 'approved' where id = ${id} and org_id = ${org.orgId}`))
    // The old refusal was a remedy-less 404; the named refusal is a 422
    // that tells the operator where the switch lives.
    const error = await withOrgContext(org.orgId, () =>
      convertOrder(org.orgId, actor, id, 'vendor_bill').then(
        () => null,
        (cause) => cause,
      ),
    )
    assert.ok(error instanceof ConversionError, `expected a ConversionError, got ${String(error)}`)
    assert.equal(error.status, 422)
    assert.match(error.message, /Equipment is disabled/)
    assert.match(error.message, /Company Settings/)
    const converted = await withBypassContext(() => db.execute(sql`
      select count(*)::int as n from documents where org_id = ${org.orgId} and kind = 'vendor_bill'`))
    assert.equal(converted.rows[0]!.n, 0, 'a refused conversion persists nothing')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
