import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const stateKey = Symbol.for('openbooks.custom-fields-route-test')
interface RouteState {
  existing: {
    target_table: string
    target_kind: string | null
    key: string
  } | null
  executed: string[]
}

const state: RouteState = {
  existing: {
    target_table: 'documents',
    target_kind: 'vendor_bill',
    key: 'shipping_method',
  },
  executed: [],
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks
  if (!Array.isArray(chunks)) return ''
  return chunks
    .map((chunk) => {
      if (typeof chunk === 'string') return chunk
      const value = (chunk as { value?: unknown[] })?.value
      if (Array.isArray(value)) return value.map(String).join('')
      if ((chunk as { queryChunks?: unknown[] })?.queryChunks) return sqlText(chunk)
      return ''
    })
    .join('')
}
;(globalThis as typeof globalThis & Record<string, unknown>).openbooksSqlTextCustomFields = sqlText

const ORG_ID = '00000000-0000-4000-8000-00000000a001'

const mockSources = new Map<string, string>([
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.custom-fields-route-test')]
      const sqlText = globalThis.openbooksSqlTextCustomFields
      export const db = {
        async execute(query) {
          const text = sqlText(query)
          state.executed.push(text)
          if (text.includes('select target_table')) {
            return { rows: state.existing ? [state.existing] : [] }
          }
          return { rows: [] }
        },
      }
    `,
  ],
  [
    'mock:authz',
    `
      export async function guardPermission() {
        return { user: { orgId: '${ORG_ID}', id: '00000000-0000-4000-8000-00000000a002' } }
      }
    `,
  ],
  [
    'mock:feature-gates',
    `
      export async function isCustomFieldTargetEnabled() { return true }
    `,
  ],
  [
    'mock:documents-adapter',
    `
      export const RESERVED_DOCUMENT_FIELD_KEYS = new Set()
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['@openbooks/engine/src/db.ts', 'mock:db'],
  ['@openbooks/engine/src/flows/documents-adapter.ts', 'mock:documents-adapter'],
  ['../../../../lib/authz', 'mock:authz'],
  ['../../../../lib/customization/gates', 'mock:feature-gates'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    if (specifier === '@/lib/api/json') {
      return { url: 'mock:json', shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    if (url === 'mock:json') {
      return {
        format: 'module',
        source: `
          export const jsonObject = {}
          export async function parseJsonBody(req) {
            const raw = await req.json().catch(() => undefined)
            if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
              return { ok: false, response: new Response(JSON.stringify({ error: 'invalid request body' }), { status: 400, headers: { 'content-type': 'application/json' } }) }
            }
            return { ok: true, data: raw }
          }
        `,
        shortCircuit: true,
      }
    }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?custom-fields-route-test'
const { PATCH } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function reset(): void {
  state.existing = {
    target_table: 'documents',
    target_kind: 'vendor_bill',
    key: 'shipping_method',
  }
  state.executed = []
}

function patch(body: Record<string, unknown>): Promise<Response> {
  return PATCH(
    new Request('http://openbooks.test/api/admin/custom-fields', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: '00000000-0000-4000-8000-00000000a003', ...body }),
    }),
  )
}

function assertNoUpdate(): void {
  assert.ok(!state.executed.some((text) => text.includes('update custom_field_defs')), 'no update was issued')
}

test('PATCH rejects select fields with missing or empty options before writing', async () => {
  for (const config of [{}, { options: [] }, { options: [''] }]) {
    reset()
    const response = await patch({ label: 'Shipping method', fieldType: 'select', config })

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: 'select fields need at least one option' })
    assertNoUpdate()
  }
})

test('PATCH rejects multi_select fields with missing or empty options before writing', async () => {
  for (const config of [{}, { options: [] }, { options: [''] }]) {
    reset()
    const response = await patch({ label: 'Shipping methods', fieldType: 'multi_select', config })

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: 'select fields need at least one option' })
    assertNoUpdate()
  }
})

test('PATCH accepts valid option updates and keeps the write organization-scoped', async () => {
  reset()
  const response = await patch({
    label: 'Shipping methods',
    fieldType: 'multi_select',
    config: { options: ['Ground', 'Air'] },
    isRequired: true,
    isActive: true,
  })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  const update = state.executed.find((text) => text.includes('update custom_field_defs'))
  assert.ok(update, 'the valid update was issued')
  assert.match(update, /org_id/)
})

test('PATCH reuses reference-table validation and accepts valid reference updates', async () => {
  reset()
  const invalid = await patch({ label: 'Owner', fieldType: 'reference', config: {} })
  assert.equal(invalid.status, 400)
  assert.deepEqual(await invalid.json(), {
    error: 'reference fields need a valid referenceTable (parties, projects, accounts, items)',
  })
  assertNoUpdate()

  reset()
  const valid = await patch({ label: 'Owner', fieldType: 'reference', config: { referenceTable: 'parties' } })
  assert.equal(valid.status, 200)
  assert.deepEqual(await valid.json(), { ok: true })
  assert.ok(state.executed.some((text) => text.includes('update custom_field_defs')), 'the valid update was issued')
})
