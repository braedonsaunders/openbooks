import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '../locale' && context.parentURL?.includes('/pdf-templates/values')) return { shortCircuit: true, url: 'data:text/javascript,export async function resolveLocale(){return "en-CA"}' }
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    return next(specifier, context)
  },
})
const { sql } = await import('drizzle-orm')
const { db, pool, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { loadPdfRecordValues, MissingPdfOrgError } = await import('./values')
const DB = !!process.env.OPENBOOKS_DB_URL

test('document PDF amounts print in the document currency, not a fallback', { skip: !DB }, async () => {
  // One policy: the document's currency, else the org's base. A EUR invoice
  // in a CAD org prints € amounts with a EUR merge value — the formatter and
  // the printed currency once disagreed (USD vs CAD) because each named its
  // own literal.
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const id = randomUUID()
    await withBypassContext(() => db.execute(sql`
      insert into documents (id, org_id, kind, document_number, document_date, currency, subtotal, tax_total, total)
      values (${id}, ${org.orgId}, 'customer_invoice', 'INV-EUR-1', '2026-07-15', 'EUR', '100', '0', '100')`))
    // Reads through a web reader run inside withOrgContext — importing the
    // reader pulls the web request-org resolver, which denies outside a scope.
    const loaded = await withOrgContext(org.orgId, () => loadPdfRecordValues('customer_invoice', org.orgId, id))
    assert.ok(loaded, 'expected values for the inserted invoice')
    assert.equal(loaded.values['currency'], 'EUR')
    assert.match(String(loaded.values['total']), /€/)
    assert.doesNotMatch(String(loaded.values['total']), /\$/)
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('a record whose org row is gone is refused, never printed in an invented currency', { skip: !DB }, async () => {
  // base_currency is NOT NULL, so the only way the org lookup misses is a
  // missing org row — a state the schema forbids. The loader must refuse by
  // name instead of falling back to an invented denomination (it once
  // printed CAD for a missing org). documents.org_id carries no FK, so the
  // test orphans the record by pointing it at a uuid with no org row.
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const id = randomUUID()
    const orphanOrg = randomUUID()
    await withBypassContext(() => db.execute(sql`
      insert into documents (id, org_id, kind, document_number, document_date, currency, subtotal, tax_total, total)
      values (${id}, ${org.orgId}, 'customer_invoice', 'INV-ORPHAN-1', '2026-07-15', 'EUR', '100', '0', '100')`))
    await withBypassContext(() => db.execute(sql`
      update documents set org_id = ${orphanOrg} where id = ${id}`))
    try {
      await assert.rejects(
        withOrgContext(orphanOrg, () => loadPdfRecordValues('customer_invoice', orphanOrg, id)),
        (e: unknown) => {
          assert.ok(e instanceof MissingPdfOrgError, `expected MissingPdfOrgError, got ${e}`)
          assert.match((e as Error).message, /invented currency/)
          return true
        },
      )
    } finally {
      await withBypassContext(() => db.execute(sql`
        update documents set org_id = ${org.orgId} where id = ${id}`))
    }
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test.after(async () => { await pool.end() })
