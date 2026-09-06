import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Route boundary suite for /api/pdf-templates/[id]: the REAL GET/PATCH/DELETE
// handlers run against scripted gates and a spied template store. A malformed
// id must be answered as the same 404 a missing template gets, before the
// store is consulted — otherwise the raw id reaches a uuid column and the
// route surfaces a database error as a 500.

const stateKey = Symbol.for('openbooks.pdf-template-id-route-test')
const state = { lookups: [] as string[], writes: 0 }
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
    'db',
    `
      const state = globalThis[Symbol.for('openbooks.pdf-template-id-route-test')]
      export const db = {
        async transaction(work) { state.writes += 1; return work({ execute: async () => ({ rows: [] }) }) },
        async execute() { return { rows: [] } },
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
      export async function guardPermission() {
        return { user: { id: 'user-1', orgId: 'org-1' }, permissions: new Set(['admin.customization.manage']), allowedSubsidiaryIds: null }
      }
    `,
  ],
  ['documents', `export async function isDocKindEnabled() { return true }`],
  ['prettify', `export async function prettifyTemplateHtml(source) { return source }`],
  [
    'store',
    `
      const state = globalThis[Symbol.for('openbooks.pdf-template-id-route-test')]
      export async function getPdfTemplate(_orgId, id) {
        state.lookups.push(id)
        return null
      }
    `,
  ],
])

const SELF_URL = new URL(import.meta.url).href
const mockUrl = (name: string) => `${SELF_URL}?mock=${name}`

const mockUrls = new Map<string, string>([
  ['@/lib/api/json', mockUrl('json')],
  ['@openbooks/engine/src/db.ts', mockUrl('db')],
  ['@openbooks/pdf', mockUrl('pdf')],
  ['../../../../lib/authz', mockUrl('authz')],
  ['../../../../lib/documents', mockUrl('documents')],
  ['../../../../lib/pdf-templates/prettify', mockUrl('prettify')],
  ['../../../../lib/pdf-templates/store', mockUrl('store')],
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

const routeUrl = './route.ts?pdf-template-id-route-test'
const { GET, PATCH, DELETE } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function reset(): void {
  state.lookups = []
  state.writes = 0
}

const params = (id: string) => ({ params: Promise.resolve({ id }) })
const url = (id: string) => `http://openbooks.test/api/pdf-templates/${encodeURIComponent(id)}`

test('a missing template is a plain 404 on every verb', async () => {
  reset()
  const id = '00000000-0000-4000-8000-00000000b001'
  for (const response of [
    await GET(new Request(url(id)), params(id)),
    await PATCH(new Request(url(id), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"name":"x"}' }), params(id)),
    await DELETE(new Request(url(id), { method: 'DELETE' }), params(id)),
  ]) {
    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), { error: 'not found' })
  }
  assert.deepEqual(state.lookups, [id, id, id])
})

test('a malformed template id is indistinguishable from a missing one and never reaches the store', async () => {
  for (const bad of ['not-a-uuid', '1 or 1=1', '00000000-0000-4000-8000-00000000b00', 'starter']) {
    reset()
    for (const response of [
      await GET(new Request(url(bad)), params(bad)),
      await PATCH(new Request(url(bad), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"name":"x"}' }), params(bad)),
      await DELETE(new Request(url(bad), { method: 'DELETE' }), params(bad)),
    ]) {
      assert.equal(response.status, 404, `"${bad}" must be a plain not-found`)
      assert.deepEqual(await response.json(), { error: 'not found' })
    }
    assert.deepEqual(state.lookups, [], `"${bad}" must never be bound to the uuid column`)
    assert.equal(state.writes, 0)
  }
})
