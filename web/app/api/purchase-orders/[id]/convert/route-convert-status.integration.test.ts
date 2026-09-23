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
