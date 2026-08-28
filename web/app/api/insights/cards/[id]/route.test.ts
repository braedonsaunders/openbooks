import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const stateKey = Symbol.for('openbooks.insight-card-route-test')
const CARD_ID = '00000000-0000-4000-8000-00000000c001'
const STORED_REVISION = '2026-08-24T12:00:00.300001Z'
const NEXT_REVISION = '2026-08-24T12:00:00.300002Z'

interface DbCall {
  text: string
}
interface Card {
  id: string
  name: string
  description: string | null
  query: unknown
  viz_type: 'bar'
  viz_settings: Record<string, unknown>
  status: 'draft'
  allowed_roles: string[] | null
  updated_at: string
}
interface RouteState {
  calls: DbCall[]
  card: Card
  currentRevision: string
  updateSucceeds: boolean
}

const routeState: RouteState = {
  calls: [],
  card: {
    id: CARD_ID,
    name: 'Original card',
    description: null,
    query: { source: 'ledger_lines' },
    viz_type: 'bar',
    viz_settings: {},
    status: 'draft',
    allowed_roles: null,
    updated_at: STORED_REVISION,
  },
  currentRevision: STORED_REVISION,
  updateSucceeds: true,
}

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

;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState
;(globalThis as typeof globalThis & Record<string, unknown>).openbooksSqlTextCard = sqlText

const mockSources = new Map<string, string>([
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.insight-card-route-test')]
      const sqlText = globalThis.openbooksSqlTextCard
      export const db = {
        execute: async (query) => {
          const text = sqlText(query)
          state.calls.push({ text })
          if (text.includes('update insight_cards')) return { rows: state.updateSucceeds ? [{ id: state.card.id }] : [] }
          if (text.includes('updatedAt')) return { rows: [{ updatedAt: state.currentRevision }] }
          return { rows: [] }
        },
      }
      export const schema = {}
      export const pool = {}
      export const env = {}
    `,
  ],
  [
    'mock:authz',
    `
      export async function guardPermission(permission) {
        if (permission === 'insights.read' || permission === 'insights.create') {
          return { user: { orgId: 'org-1', id: 'user-1' } }
        }
        return new Response(null, { status: 403 })
      }
    `,
  ],
  ['mock:money', `export function normalizeMoney(value) { return String(value) }`],
  [
    'mock:json',
    `
      export const jsonObject = {}
      export async function parseJsonBody(req) {
        const data = await req.json().catch(() => undefined)
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
          return { ok: false, response: new Response(JSON.stringify({ error: 'invalid request body' }), { status: 400, headers: { 'content-type': 'application/json' } }) }
        }
        return { ok: true, data }
      }
    `,
  ],
  [
    'mock:insights-lib',
    `
      const state = globalThis[Symbol.for('openbooks.insight-card-route-test')]
      export function isVizType(value) { return ['table', 'bar', 'line', 'area', 'pie'].includes(value) }
      export function normalizeQuery(value) { return value }
      export function normalizeVizSettings(value) { return value ?? {} }
      export function normalizeAllowedRoles(value) { return value }
      export function strOrNull(value) { return typeof value === 'string' && value.trim() ? value.trim() : null }
      export async function loadCard() { return state.card }
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['@openbooks/engine/src/db.ts', 'mock:db'],
  ['@openbooks/engine/src/money.ts', 'mock:money'],
  ['@/lib/api/json', 'mock:json'],
  ['../../../../../lib/authz', 'mock:authz'],
  ['../../_lib', 'mock:insights-lib'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only')
      return {
        shortCircuit: true,
        format: 'module',
        url: 'data:text/javascript,export {}',
      }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    if (specifier.startsWith('@/lib/') && context.parentURL) {
      return nextResolve(new URL(`../../../../../${specifier.slice(2)}.ts`, context.parentURL).href, context)
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const routeUrl = new URL('./route.ts?insight-card-occ-test', import.meta.url).href
const { GET, PATCH } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function reset() {
  routeState.calls.length = 0
  routeState.currentRevision = STORED_REVISION
  routeState.updateSucceeds = true
}

function patch(body: Record<string, unknown>): Promise<Response> {
  return PATCH(
    new Request(`http://openbooks.test/api/insights/cards/${CARD_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: CARD_ID }) },
  )
}

function get(): Promise<Response> {
  return GET(new Request(`http://openbooks.test/api/insights/cards/${CARD_ID}`), {
    params: Promise.resolve({ id: CARD_ID }),
  })
}

test('PATCH requires a revision token before writing', async () => {
  reset()
  const response = await patch({ name: 'missing token' })
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), {
    error: 'the card revision is required; reload and review the latest revision',
  })
  assert.equal(routeState.calls.filter((call) => call.text.includes('update insight_cards')).length, 0)
})

test('PATCH rejects a stale revision without overwriting the newer card', async () => {
  reset()
  routeState.updateSucceeds = false
  const response = await patch({
    name: 'stale save',
    expectedUpdatedAt: '2026-08-24T12:00:00.300000Z',
  })
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), {
    error: 'this card changed after you opened it; reload and review the latest revision',
  })
  assert.equal(routeState.calls.filter((call) => call.text.includes('update insight_cards')).length, 1)
})

test('PATCH writes under an exact revision and returns the next revision', async () => {
  reset()
  routeState.currentRevision = NEXT_REVISION
  const response = await patch({
    name: 'newer save',
    expectedUpdatedAt: STORED_REVISION,
  })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).updated_at, NEXT_REVISION)
  const update = routeState.calls.find((call) => call.text.includes('update insight_cards'))
  assert.ok(update)
  assert.match(update.text, /updated_at = greatest\(/)
  assert.match(update.text, /expectedUpdatedAt|timestamptz/)
})

test('GET exposes an exact revision token for the next save', async () => {
  reset()
  const response = await get()
  assert.equal(response.status, 200)
  assert.equal((await response.json()).updated_at, STORED_REVISION)
})
