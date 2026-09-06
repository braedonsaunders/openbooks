import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { PDF_RECORD_TYPES } from '../../../../lib/pdf-templates/catalog'

// Route boundary suite for the template-editor preview. The preview renders a
// REAL record of the org (the most recent one) so the designer sees true
// output — which makes it a disclosure surface. It must therefore demand the
// same read authority as printing that record, and choose its sample inside
// the caller's subsidiary scope, never from the whole org.

const stateKey = Symbol.for('openbooks.pdf-template-preview-route-test')
interface PreviewState {
  granted: Set<string>
  allowedSubsidiaryIds: Set<string> | null
  sampleCalls: unknown[][]
  valueCalls: string[]
  renderCalls: number
}
const state: PreviewState = { granted: new Set(), allowedSubsidiaryIds: null, sampleCalls: [], valueCalls: [], renderCalls: 0 }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

const mockSources = new Map<string, string>([
  [
    'json',
    `
      import { NextResponse } from 'next/server'
      export const jsonObject = {}
      export async function parseJsonBody(req) {
        const raw = await req.json().catch(() => undefined)
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
          return { ok: false, response: NextResponse.json({ error: 'invalid request body' }, { status: 400 }) }
        }
        return { ok: true, data: raw }
      }
    `,
  ],
  [
    'pdf',
    `
      export function compileTemplateHtml(source) { return { sanitizedSource: source, compiledHtml: source } }
      export function sanitizeTokenizedFragment(fragment) { return fragment }
    `,
  ],
  [
    'authz',
    `
      const state = globalThis[Symbol.for('openbooks.pdf-template-preview-route-test')]
      import { NextResponse } from 'next/server'
      function covers(perm) { return state.granted.has('*') || state.granted.has(perm) }
      export async function guardPermission(perm) {
        if (!covers(perm)) return NextResponse.json({ error: \`missing permission: \${perm}\` }, { status: 403 })
        return { user: { id: 'user-1', orgId: 'org-1' }, permissions: state.granted, allowedSubsidiaryIds: state.allowedSubsidiaryIds }
      }
      export function can(_authz, perm) { return covers(perm) }
    `,
  ],
  ['documents', `export async function isDocKindEnabled() { return true }`],
  [
    'export',
    `export function pdfResponse(pdf) { return new Response(pdf, { status: 200, headers: { 'content-type': 'application/pdf' } }) }`,
  ],
  [
    'render',
    `
      const state = globalThis[Symbol.for('openbooks.pdf-template-preview-route-test')]
      export async function mergeAndPrintPdf() { state.renderCalls += 1; return Buffer.from('%PDF-1.4 test') }
    `,
  ],
  [
    'values',
    `
      const state = globalThis[Symbol.for('openbooks.pdf-template-preview-route-test')]
      export async function findSamplePdfRecordId(...args) {
        state.sampleCalls.push(args)
        return '00000000-0000-4000-8000-00000000c001'
      }
      export async function loadPdfRecordValues(_recordType, _orgId, id) {
        state.valueCalls.push(id)
        return { values: { party_name: 'Real Customer' }, reference: 'INV-000001' }
      }
    `,
  ],
])

const SELF_URL = new URL(import.meta.url).href
const mockUrl = (name: string) => `${SELF_URL}?mock=${name}`

const mockUrls = new Map<string, string>([
  ['@/lib/api/json', mockUrl('json')],
  ['@openbooks/pdf', mockUrl('pdf')],
  ['../../../../lib/authz', mockUrl('authz')],
  ['../../../../lib/documents', mockUrl('documents')],
  ['../../../../lib/export', mockUrl('export')],
  ['../../../../lib/pdf-templates/render', mockUrl('render')],
  ['../../../../lib/pdf-templates/values', mockUrl('values')],
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

const routeUrl = './route.ts?pdf-template-preview-route-test'
const { POST } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function reset(): void {
  state.granted = new Set()
  state.allowedSubsidiaryIds = null
  state.sampleCalls = []
  state.valueCalls = []
  state.renderCalls = 0
}

function preview(recordType: string): Promise<Response> {
  return POST(
    new Request('http://openbooks.test/api/pdf-templates/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ recordType, sourceHtml: '<p>{{party_name}}</p>' }),
    }),
  )
}

test('designer authority alone cannot preview against a real record of any type', async () => {
  for (const meta of PDF_RECORD_TYPES) {
    reset()
    state.granted = new Set(['admin.customization.manage'])

    const response = await preview(meta.key)

    assert.equal(response.status, 403, `${meta.key}: admin.customization.manage alone must not disclose a record`)
    assert.deepEqual(await response.json(), { error: `missing permission: ${meta.readPermission}` })
    assert.deepEqual(state.sampleCalls, [], `${meta.key}: no sample record is looked up`)
    assert.deepEqual(state.valueCalls, [], `${meta.key}: no record values are loaded`)
    assert.equal(state.renderCalls, 0)
  }
})

test('the sample record is chosen inside the caller’s subsidiary scope', async () => {
  for (const meta of PDF_RECORD_TYPES) {
    reset()
    state.granted = new Set(['admin.customization.manage', meta.readPermission])
    state.allowedSubsidiaryIds = new Set(['00000000-0000-4000-8000-000000000099'])

    const response = await preview(meta.key)

    assert.equal(response.status, 200, meta.key)
    assert.equal(state.sampleCalls.length, 1, `${meta.key}: exactly one sample lookup`)
    const [recordType, orgId, scope] = state.sampleCalls[0]!
    assert.equal(recordType, meta.key)
    assert.equal(orgId, 'org-1')
    assert.deepEqual(scope, state.allowedSubsidiaryIds, `${meta.key}: the lookup carries the caller's subsidiary scope`)
    assert.equal(state.renderCalls, 1)
  }
})

test('an unrestricted designer with read authority previews the org-wide latest record', async () => {
  reset()
  state.granted = new Set(['admin.customization.manage', 'ar.read'])

  const response = await preview('customer_invoice')

  assert.equal(response.status, 200)
  assert.deepEqual(state.sampleCalls, [['customer_invoice', 'org-1', null]])
  assert.deepEqual(state.valueCalls, ['00000000-0000-4000-8000-00000000c001'])
})
