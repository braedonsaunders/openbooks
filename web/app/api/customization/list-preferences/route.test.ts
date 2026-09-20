import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Route-boundary regression for list-preferences PUT. resolveListView only
// loads is_active rows, so an inactive (or concurrently deactivated) view
// must never persist as {ok}. The fake database records whether the active
// probe and the preference upsert share one transaction and whether the
// probe locks FOR UPDATE — it does not inspect the route source.

const stateKey = Symbol.for('openbooks.list-preferences-route-test')
interface DbCall { kind: 'execute' | 'tx-execute'; text: string }
interface RouteState {
  calls: DbCall[]
  inTx: boolean
  respondTx: (text: string) => { rows: unknown[]; rowCount?: number }
}
const routeState: RouteState = {
  calls: [],
  inTx: false,
  respondTx: () => ({ rows: [] }),
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState

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
;(globalThis as typeof globalThis & { openbooksSqlTextListPrefs?: unknown }).openbooksSqlTextListPrefs = sqlText

const VIEW_ID = '11111111-1111-4111-8111-111111111111'

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier.startsWith('@/')) {
      return nextResolve(
        new URL(`../../../../../web/${specifier.slice(2)}.ts`, import.meta.url).href,
        context,
      )
    }
    if (specifier === '../../../../lib/authz') {
      return { shortCircuit: true, url: 'mock:authz' }
    }
    if (specifier === '../../../../lib/customization/gates') {
      return { shortCircuit: true, url: 'mock:gates' }
    }
    if (specifier === '@openbooks/engine/src/platform/db.ts') {
      return { shortCircuit: true, url: 'mock:db' }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:authz') {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export async function getAuthz() {
            return { user: { orgId: 'org-1', id: 'user-1' }, permissions: [], allowedSubsidiaryIds: null }
          }
        `,
      }
    }
    if (url === 'mock:gates') {
      return {
        format: 'module',
        shortCircuit: true,
        source: `export async function refuseDisabledRecordType() { return null }`,
      }
    }
    if (url === 'mock:db') {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          const state = globalThis[Symbol.for('openbooks.list-preferences-route-test')]
          const sqlText = globalThis.openbooksSqlTextListPrefs
          const record = (kind, query) => {
            const text = sqlText(query)
            state.calls.push({ kind, text })
            if (kind === 'execute') return Promise.resolve({ rows: [], rowCount: 0 })
            return Promise.resolve(state.respondTx(text))
          }
          export const db = {
            execute: (query) => record('execute', query),
            transaction: async (work) => {
              state.inTx = true
              try {
                const tx = { execute: (query) => record('tx-execute', query) }
                return await work(tx)
              } finally {
                state.inTx = false
              }
            },
          }
        `,
      }
    }
    return nextLoad(url, context)
  },
})

const { PUT } = (await import('./route.ts?list-preferences-inactive-lock')) as typeof import('./route.ts')
hooks.deregister()

function reset(respondTx: RouteState['respondTx']): void {
  routeState.calls = []
  routeState.respondTx = respondTx
}

function put(body: unknown): Promise<Response> {
  return PUT(
    new Request('http://openbooks.test/api/customization/list-preferences', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

function txCalls(): DbCall[] {
  return routeState.calls.filter((call) => call.kind === 'tx-execute')
}

test('PUT refuses an inactive owned view before the preference upsert', async () => {
  reset((text) => {
    if (text.includes('from list_views')) {
      return { rows: [{ isActive: false, name: 'Archived bills' }], rowCount: 1 }
    }
    return { rows: [], rowCount: 1 }
  })

  const response = await put({ recordType: 'vendor_bill', viewId: VIEW_ID })
  const json = (await response.json()) as { error?: string; ok?: unknown }

  assert.equal(response.status, 422, JSON.stringify(json))
  assert.equal(json.ok, undefined)
  assert.match(String(json.error ?? ''), /list view "Archived bills" is inactive/)
  assert.match(String(json.error ?? ''), /reactivate it or choose an active view/)
  assert.ok(
    !routeState.calls.some((call) => call.text.includes('insert into user_list_preferences')),
    'inactive view must not write a preference resolveListView cannot apply',
  )
})

test('PUT treats a missing view as not found and writes nothing', async () => {
  reset(() => ({ rows: [], rowCount: 0 }))

  const response = await put({ recordType: 'vendor_bill', viewId: VIEW_ID })
  const json = (await response.json()) as { error?: string; ok?: unknown }

  assert.equal(response.status, 404, JSON.stringify(json))
  assert.equal(json.ok, undefined)
  assert.equal(json.error, 'list view not found')
  assert.ok(!routeState.calls.some((call) => call.text.includes('insert into user_list_preferences')))
})

test('PUT locks the view FOR UPDATE in the same transaction as the upsert', async () => {
  reset((text) => {
    if (text.includes('from list_views')) {
      return { rows: [{ isActive: true, name: 'Open bills' }], rowCount: 1 }
    }
    if (text.includes('insert into user_list_preferences')) return { rows: [], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  })

  const response = await put({ recordType: 'vendor_bill', viewId: VIEW_ID })
  const json = (await response.json()) as { ok?: unknown; viewId?: string }

  assert.equal(response.status, 200, JSON.stringify(json))
  assert.equal(json.ok, true)
  assert.equal(json.viewId, VIEW_ID)
  assert.equal(routeState.calls.filter((call) => call.kind === 'execute').length, 0, 'probe and write must not use unlocked pool execute')

  const lock = txCalls().find((call) => call.text.includes('from list_views') && call.text.includes('for update'))
  const write = txCalls().find((call) => call.text.includes('insert into user_list_preferences'))
  assert.ok(lock, 'the preference write must lock the list_views row FOR UPDATE')
  assert.ok(write, 'the preference upsert must run inside the same transaction')
  assert.ok(
    routeState.calls.indexOf(lock!) < routeState.calls.indexOf(write!),
    'the lock must precede the upsert so a concurrent deactivation waits',
  )
})

test('PUT refuses a zero-row preference write instead of reporting ok', async () => {
  reset((text) => {
    if (text.includes('from list_views')) {
      return { rows: [{ isActive: true, name: 'Open bills' }], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  })

  const response = await put({ recordType: 'vendor_bill', viewId: VIEW_ID })
  const json = (await response.json()) as { error?: string; ok?: unknown }

  assert.equal(response.status, 409, JSON.stringify(json))
  assert.equal(json.ok, undefined)
  assert.match(String(json.error ?? ''), /list preference was not saved/)
  assert.match(String(json.error ?? ''), /still active/)
})

test('PUT still clears a preference when viewId is null', async () => {
  reset((text) => {
    if (text.includes('insert into user_list_preferences')) return { rows: [], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  })

  const response = await put({ recordType: 'vendor_bill', viewId: null })
  const json = (await response.json()) as { ok?: unknown; viewId?: string | null }

  assert.equal(response.status, 200, JSON.stringify(json))
  assert.equal(json.ok, true)
  assert.equal(json.viewId, null)
  assert.ok(txCalls().some((call) => call.text.includes('insert into user_list_preferences')))
  assert.ok(!txCalls().some((call) => call.text.includes('from list_views')))
})
