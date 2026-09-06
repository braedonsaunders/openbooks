import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Route boundary suite for the record PDF print endpoint: the REAL handler runs
// against scripted gates and spied loaders. It pins that a malformed record id
// is answered exactly like a missing record (404, same body) before any scope
// resolution or record load, so an unvalidated id can never reach a uuid
// column and surface as a 500.

const stateKey = Symbol.for('openbooks.record-pdf-print-route-test')
interface PrintRouteState {
  granted: Set<string>
  scopeCalls: string[]
  valueCalls: string[]
  renderCalls: number
}
const state: PrintRouteState = { granted: new Set(), scopeCalls: [], valueCalls: [], renderCalls: 0 }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

const mockSources = new Map<string, string>([
  [
    'authz',
    `
      const state = globalThis[Symbol.for('openbooks.record-pdf-print-route-test')]
      import { NextResponse } from 'next/server'
      export async function guardPermission(perm) {
        if (!state.granted.has('*') && !state.granted.has(perm)) {
          return NextResponse.json({ error: \`missing permission: \${perm}\` }, { status: 403 })
        }
        return { user: { id: 'user-1', orgId: 'org-1' }, permissions: state.granted, allowedSubsidiaryIds: null }
      }
      export function guardSubsidiaryScope() { return null }
    `,
  ],
  ['documents', `export async function isDocKindEnabled() { return true }`],
  [
    'export',
    `
      export function pdfResponse(pdf) { return new Response(pdf, { status: 200, headers: { 'content-type': 'application/pdf' } }) }
      export function safeName(name) { return name }
    `,
  ],
  [
    'render',
    `
      const state = globalThis[Symbol.for('openbooks.record-pdf-print-route-test')]
      export async function mergeAndPrintPdf() { state.renderCalls += 1; return Buffer.from('%PDF-1.4 test') }
    `,
  ],
  ['store', `export async function resolvePdfTemplate() { return { compiledHtml: '<p/>', paperSize: 'letter', orientation: 'portrait', marginMm: 14, headerHtml: null, footerHtml: null } }`],
  [
    'values',
    `
      const state = globalThis[Symbol.for('openbooks.record-pdf-print-route-test')]
      export async function loadPdfRecordValues(_recordType, _orgId, id) {
        state.valueCalls.push(id)
        return { values: {}, reference: 'INV-000001' }
      }
    `,
  ],
  [
    'record-scope',
    `
      const state = globalThis[Symbol.for('openbooks.record-pdf-print-route-test')]
      export async function loadRecordSubsidiaryScope(_recordType, _orgId, id) {
        state.scopeCalls.push(id)
        return { subsidiaryId: null }
      }
    `,
  ],
  ['business-date', `export async function businessToday() { return '2026-09-05' }`],
])

const SELF_URL = new URL(import.meta.url).href
const mockUrl = (name: string) => `${SELF_URL}?mock=${name}`

const mockUrls = new Map<string, string>([
  ['../../../../../lib/authz', mockUrl('authz')],
  ['../../../../../lib/documents', mockUrl('documents')],
  ['../../../../../lib/export', mockUrl('export')],
  ['../../../../../lib/pdf-templates/render', mockUrl('render')],
  ['../../../../../lib/pdf-templates/store', mockUrl('store')],
  ['../../../../../lib/pdf-templates/values', mockUrl('values')],
  ['../../lib', mockUrl('record-scope')],
  ['@openbooks/engine/src/business-date.ts', mockUrl('business-date')],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const parsed = new URL(url)
    if (parsed.search.startsWith('?mock=')) {
      const source = mockSources.get(parsed.searchParams.get('mock') ?? '')
      if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?record-pdf-print-route-test'
const { GET } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function reset(): void {
  state.granted = new Set(['ar.read'])
  state.scopeCalls = []
  state.valueCalls = []
  state.renderCalls = 0
}

function get(id: string): Promise<Response> {
  return GET(new Request(`http://openbooks.test/api/record-pdf/customer_invoice/${encodeURIComponent(id)}`), {
    params: Promise.resolve({ recordType: 'customer_invoice', id }),
  })
}

test('a well-formed id prints on read authority', async () => {
  reset()
  const response = await get('00000000-0000-4000-8000-00000000a001')
  assert.equal(response.status, 200)
  assert.equal(state.renderCalls, 1)
})

test('a malformed id is refused exactly like a missing record, before scope or record loads', async () => {
  for (const bad of ['not-a-uuid', '1 or 1=1', '00000000-0000-4000-8000-00000000a00', 'INV-000001']) {
    reset()
    const response = await get(bad)
    assert.equal(response.status, 404, `"${bad}" must be a plain not-found`)
    assert.deepEqual(await response.json(), { error: 'record not found' })
    assert.deepEqual(state.scopeCalls, [], `"${bad}" never reaches the subsidiary lookup`)
    assert.deepEqual(state.valueCalls, [], `"${bad}" never reaches the record loader`)
    assert.equal(state.renderCalls, 0)
  }
})
