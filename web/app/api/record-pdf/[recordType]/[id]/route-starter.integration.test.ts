import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { randomUUID } from 'node:crypto'
import { env } from '@openbooks/engine/src/platform/db.ts'

/**
 * An invoice with no org-authored PDF template still prints: the record-PDF
 * route falls back to the native starter design (template id/revision null,
 * content hash present) instead of 404ing. Only the render step is doubled —
 * template resolution, record values and the subsidiary fence all run for
 * real, so a regression in the default chain fails here, not in production.
 */
const stateKey = Symbol.for('openbooks.record-pdf-starter-test')
const state = { renders: [] as unknown[] }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" }
  // Off-request locale resolution is anonymous by contract (no cookie store
  // outside a request scope), so the auth module behind it is doubled to its
  // off-request shape instead of loading the session graph.
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/locale.ts')) {
    return { shortCircuit: true, url: 'mock:record-pdf-starter-locale-auth' }
  }
  if (specifier === '../../../../../lib/authz' && context.parentURL?.includes('record-pdf')) {
    return { shortCircuit: true, url: 'mock:record-pdf-starter-authz' }
  }
  if (specifier === '../../../../../lib/pdf-templates/render' && context.parentURL?.includes('record-pdf')) {
    return { shortCircuit: true, url: 'mock:record-pdf-starter-render' }
  }
  return next(specifier, context)
}, load(url, context, nextLoad) {
  if (url === 'mock:record-pdf-starter-locale-auth') {
    return { format: 'module', shortCircuit: true, source: `
      export async function currentUser() { return null }
      export async function currentSession() { return null }
    ` }
  }
  if (url === 'mock:record-pdf-starter-authz') {
    return { format: 'module', shortCircuit: true, source: `
      const state = globalThis[Symbol.for('openbooks.record-pdf-starter-test')]
      export async function guardPermission() {
        return { user: state.authz.user, permissions: new Set(['ar.read']), allowedSubsidiaryIds: null }
      }
      export function guardSubsidiaryScope() { return null }
    ` }
  }
  if (url === 'mock:record-pdf-starter-render') {
    return { format: 'module', shortCircuit: true, source: `
      const state = globalThis[Symbol.for('openbooks.record-pdf-starter-test')]
      export async function mergeAndPrintPdf(tpl, values) {
        state.renders.push({ tpl, valueKeys: Object.keys(values) })
        return Buffer.from('%PDF-1.4 starter-fallback\\n%%EOF')
      }
    ` }
  }
  return nextLoad(url, context)
}})

const { sql } = await import('drizzle-orm')
const { db, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { GET } = await import('./route')

const needsDb = { skip: !env.OPENBOOKS_DB_URL }

test('an invoice with no custom template prints with the native starter design', needsDb, async () => {
  const org = await createScratchOrg()
  try {
    ;(state as { authz?: unknown }).authz = { user: { id: randomUUID(), orgId: org.orgId } }
    const invoiceId = randomUUID()
    await db.execute(sql`
      insert into documents (id, org_id, kind, document_number, document_date, currency, subsidiary_id)
      values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'INV-000123', '2026-07-15', 'CAD', ${org.subsidiaryId})
    `)
    const templates = await db.execute(sql`
      select count(*)::int as n from pdf_templates where org_id = ${org.orgId} and record_type = 'customer_invoice'
    `)
    assert.equal(templates.rows[0]?.n, 0, 'the fixture org has no invoice template: the starter must print')
    const response = await withOrgContext(org.orgId, () => GET(
      new Request(`http://openbooks.test/api/record-pdf/customer_invoice/${invoiceId}`),
      { params: Promise.resolve({ recordType: 'customer_invoice', id: invoiceId }) },
    ))
    assert.equal(response.status, 200, await response.clone().text())
    assert.match(response.headers.get('content-type') ?? '', /application\/pdf/)
    assert.equal(response.headers.get('x-pdf-template-id'), null, 'a starter print cites no saved template')
    assert.equal(response.headers.get('x-pdf-template-revision'), null)
    assert.ok((response.headers.get('x-pdf-template-hash') ?? '').length >= 16, 'the starter design is still content-hashed')
    assert.equal(state.renders.length, 1, 'the starter design rendered exactly once')
    const bytes = Buffer.from(await response.arrayBuffer())
    assert.ok(bytes.toString('utf8').startsWith('%PDF'), 'the route returns PDF bytes, not a JSON body')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
