import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

type ExistingField = {
  updated_at: string
  target_table: string
  target_kind: string | null
  key: string
  label: string
  field_type: string
  config: unknown
  is_required: boolean
  sort_order: number
  is_active: boolean
}

type RouteState = {
  existing: ExistingField | null
  queries: string[]
}

const stateKey = Symbol.for('openbooks.custom-fields-route-test')
const state: RouteState = {
  existing: null,
  queries: [],
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

/** Flatten a drizzle SQL chunk into its literal text for scripted replies. */
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
;(globalThis as typeof globalThis & Record<string, unknown>).openbooksCustomFieldsSqlText = sqlText

// '@/lib/api/json' is deliberately NOT mocked here. parseJsonBody is the
// shared validation boundary, and a double of it can only return
// { ok: true } — it is structurally incapable of producing the 400 refusals
// the boundary exists to enforce, so every malformed-body case below used to
// be untested while this file reported green (AGENTS.md: never double
// validation). The real module loads through tsx; only its 'server-only'
// marker is shimmed in the resolve hook below.
const mockSources = new Map<string, string>([
  [
    'mock:authz',
    `
      export async function guardPermission() {
        return { user: { orgId: 'org-1', id: 'user-1' } }
      }
    `,
  ],
  [
    'mock:feature-gates',
    `
      export async function isCustomFieldTargetEnabled() {
        return true
      }
    `,
  ],
  [
    'mock:documents-adapter',
    `
      export const RESERVED_DOCUMENT_FIELD_KEYS = new Set(['total'])
    `,
  ],
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.custom-fields-route-test')]
      const sqlText = globalThis.openbooksCustomFieldsSqlText
      export const db = {
        async transaction(run) { return run(db) },
        async execute(query) {
          const text = sqlText(query)
          state.queries.push(text)
          if (text.includes('from custom_field_defs')) {
            return { rows: state.existing ? [state.existing] : [] }
          }
          if (text.includes('update custom_field_defs')) return { rows: [state.existing] }
          if (text.includes('insert into audit_log')) return { rows: [] }
          throw new Error('unexpected database query: ' + text)
        },
      }
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['../../../../lib/authz', 'mock:authz'],
  ['../../../../lib/customization/gates', 'mock:feature-gates'],
  ['@openbooks/engine/src/platform/db.ts', 'mock:db'],
  ['@openbooks/engine/src/flows/documents-adapter.ts', 'mock:documents-adapter'],
])

const hooks = registerHooks({
  resolve(specifier, _context, nextResolve) {
    if (specifier === 'server-only') {
      return { format: 'module', shortCircuit: true, url: 'mock:server-only' }
    }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { format: 'module', shortCircuit: true, url: mocked }
    return nextResolve(specifier)
  },
  load(url, _context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    if (url === 'mock:server-only') return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url)
  },
})

const routeUrl = '../app/api/admin/custom-fields/route.ts?custom-fields-route-test'
const { PATCH, POST } = (await import(routeUrl)) as typeof import('../app/api/admin/custom-fields/route.ts')
hooks.deregister()

const FIELD_ID = '00000000-0000-4000-8000-00000000a001'

function baseField(overrides: Partial<ExistingField> = {}): ExistingField {
  return {
    target_table: 'documents',
    target_kind: 'vendor_bill',
    key: 'shipping_zone',
    updated_at: '2026-09-05T00:00:00.123456Z',
    label: 'Shipping zone',
    field_type: 'text',
    config: {},
    is_required: false,
    sort_order: 0,
    is_active: true,
    ...overrides,
  }
}

function reset(existing: ExistingField = baseField()): void {
  state.existing = existing
  state.queries = []
}

function patchField(body: Record<string, unknown>): Promise<Response> {
  return PATCH(
    new Request('http://openbooks.test/api/admin/custom-fields', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: FIELD_ID, expectedUpdatedAt: '2026-09-05T00:00:00.123456Z', ...body }),
    }),
  )
}

function rawRequest(method: string, body: string): Request {
  return new Request('http://openbooks.test/api/admin/custom-fields', {
    method,
    headers: { 'content-type': 'application/json' },
    body,
  })
}

// The boundary refusals below are the cases the removed parseJsonBody double
// could never produce: a malformed body made it THROW a SyntaxError instead
// of refusing, and an array/null body sailed through as { ok: true } and hit
// the route's own 404 id check. They now prove the real shared boundary fires
// with its own message before any database work.
test('PATCH refuses a malformed JSON body at the shared boundary before any database work', async () => {
  reset()
  const malformed = await PATCH(rawRequest('PATCH', '{"label":'))
  assert.equal(malformed.status, 400)
  assert.deepEqual(await malformed.json(), { error: 'invalid request body' })
  assert.equal(state.queries.length, 0)
})

test('PATCH refuses non-object bodies instead of trusting their shape', async () => {
  for (const body of ['[{"id": "x"}]', 'null', '"shipping zone"']) {
    reset()
    const refused = await PATCH(rawRequest('PATCH', body))
    assert.equal(refused.status, 400, `body ${body} must be refused`)
    assert.deepEqual(await refused.json(), { error: 'invalid request body' })
    assert.equal(state.queries.length, 0, `no database work for body ${body}`)
  }
})

test('POST refuses a malformed JSON body at the shared boundary before any write', async () => {
  reset()
  const malformed = await POST(rawRequest('POST', '{"targetTable":'))
  assert.equal(malformed.status, 400)
  assert.deepEqual(await malformed.json(), { error: 'invalid request body' })
  assert.equal(state.queries.length, 0)
})

test('PATCH rejects creation-invalid labels and select options before writing', async () => {
  reset()

  const overlongLabel = await patchField({ label: 'x'.repeat(121), fieldType: 'text', config: {} })
  assert.equal(overlongLabel.status, 400)
  assert.deepEqual(await overlongLabel.json(), { error: 'label required' })
  assert.equal(state.queries.some((query) => query.includes('update custom_field_defs')), false)

  reset(baseField({ field_type: 'select', config: { options: ['Existing'] } }))
  const emptyOptions = await patchField({ label: 'Shipping zone', fieldType: 'select', config: { options: [] } })
  assert.equal(emptyOptions.status, 400)
  assert.deepEqual(await emptyOptions.json(), { error: 'select fields need at least one option' })
  assert.equal(state.queries.some((query) => query.includes('update custom_field_defs')), false)
})

test('PATCH rejects structural target changes but accepts a compatible type update', async () => {
  reset()

  const moved = await patchField({
    targetTable: 'parties',
    label: 'Shipping zone',
    fieldType: 'text',
    config: {},
  })
  assert.equal(moved.status, 400)
  assert.deepEqual(await moved.json(), { error: 'target table cannot be changed' })
  assert.equal(state.queries.some((query) => query.includes('update custom_field_defs')), false)

  reset()
  const compatible = await patchField({
    label: 'Shipping zone',
    fieldType: 'select',
    config: { options: ['Domestic', 'International'] },
    isRequired: true,
  })
  assert.equal(compatible.status, 200)
  assert.deepEqual(await compatible.json(), { ok: true, updatedAt: '2026-09-05T00:00:00.123456Z' })
  assert.equal(state.queries.filter((query) => query.includes('update custom_field_defs')).length, 1)
})
