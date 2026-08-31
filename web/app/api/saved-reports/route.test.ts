import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const stateKey = Symbol.for('openbooks.saved-reports-route-test')
interface RouteState {
  granted: Set<string>
  permissionCalls: string[]
  queries: unknown[]
  deleteRows: Array<{ id: string }>
  userId: string
}

const state: RouteState = {
  granted: new Set(),
  permissionCalls: [],
  queries: [],
  deleteRows: [],
  userId: 'user-1',
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
      return (chunk as { queryChunks?: unknown[] })?.queryChunks ? sqlText(chunk) : ''
    })
    .join('')
}

;(globalThis as typeof globalThis & { openbooksSavedReportsSqlText?: typeof sqlText }).openbooksSavedReportsSqlText = sqlText

const mockSources = new Map<string, string>([
  [
    'mock:authz',
    `
      import { NextResponse } from 'next/server'
      const state = globalThis[Symbol.for('openbooks.saved-reports-route-test')]
      export async function guardPermission(permission) {
        state.permissionCalls.push(permission)
        if (!state.granted.has('*') && !state.granted.has(permission)) {
          return NextResponse.json({ error: 'forbidden' }, { status: 403 })
        }
        return {
          user: { id: state.userId, orgId: 'org-1' },
          permissions: state.granted,
          allowedSubsidiaryIds: null,
        }
      }
    `,
  ],
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.saved-reports-route-test')]
      const sqlText = globalThis.openbooksSavedReportsSqlText
      export const db = {
        execute: async (query) => {
          state.queries.push(query)
          const text = sqlText(query)
          if (text.includes('delete from saved_reports')) return { rows: state.deleteRows }
          return { rows: [] }
        },
      }
    `,
  ],
  [
    'mock:json',
    `
      export const jsonObject = {}
      export async function parseJsonBody(request) {
        const raw = await request.json().catch(() => undefined)
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
          return { ok: false, response: new Response(JSON.stringify({ error: 'invalid request body' }), { status: 400 }) }
        }
        return { ok: true, data: raw }
      }
    `,
  ],
])

const SELF_URL = new URL(import.meta.url).href
const mockUrl = (name: string) => `${SELF_URL}?mock=${name}`
const mockUrls = new Map<string, string>([
  ['@openbooks/engine/src/db.ts', mockUrl('db')],
  ['../../../lib/authz', mockUrl('authz')],
  ['@/lib/api/json', mockUrl('json')],
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
    const mockName = parsed.searchParams.get('mock')
    const source = mockSources.get(mockName ? `mock:${mockName}` : url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?saved-reports-route-test'
const { DELETE, POST } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function reset(): void {
  state.granted = new Set()
  state.permissionCalls.length = 0
  state.queries.length = 0
  state.deleteRows = []
  state.userId = 'user-1'
}

function post(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request('http://openbooks.test/api/saved-reports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

function remove(id = 'report-1'): Promise<Response> {
  return DELETE(
    new Request('http://openbooks.test/api/saved-reports', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    }),
  )
}

test('read-only reporters cannot create or delete organization-wide saved reports', async () => {
  reset()
  state.granted = new Set(['reports.read'])

  const created = await post({ name: 'Read-only bookmark', path: '/reports/pnl' })
  const deleted = await remove()

  assert.equal(created.status, 403)
  assert.equal(deleted.status, 403)
  assert.deepEqual(state.permissionCalls, ['reports.create', 'reports.create'])
  assert.equal(state.queries.length, 0, 'authorization denies both mutations before database access')
})

test('reports.create can create a saved report and records its owner', async () => {
  reset()
  state.granted = new Set(['reports.create'])

  const response = await post({ name: 'Monthly P&L', path: '/reports/pnl', params: { period: 'month' } })

  assert.equal(response.status, 200)
  assert.equal(state.queries.length, 1, 'authorized creation reaches the database exactly once')
  assert.match(sqlText(state.queries[0]), /insert into saved_reports/)
  assert.match(sqlText(state.queries[0]), /created_by_user_id/)
})

test('only the saved-report owner or an administrator can delete it', async () => {
  reset()
  state.granted = new Set(['reports.create'])

  const denied = await remove()

  assert.equal(denied.status, 403)
  assert.equal(state.queries.length, 1, 'the owner check is enforced by the delete statement')
  assert.match(sqlText(state.queries[0]), /created_by_user_id =/)

  reset()
  state.granted = new Set(['reports.create'])
  state.deleteRows = [{ id: 'report-1' }]

  const ownerDeleted = await remove()

  assert.equal(ownerDeleted.status, 200)

  reset()
  state.granted = new Set(['*'])
  state.deleteRows = [{ id: 'report-1' }]

  const adminDeleted = await remove()

  assert.equal(adminDeleted.status, 200)
})
