import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

type Assignment = Record<string, unknown> & { id: string }
type Audit = { action: string; actorId: string; changes: { before: unknown; after: unknown } }

interface RouteState {
  assignments: Map<string, Assignment>
  audits: Audit[]
  txQueries: string[]
  auditFailure: boolean
  exclusionAfterFirstWrite: boolean
  writes: number
  nextId: number
}

const stateKey = Symbol.for('openbooks.rate-book-assignment-route-test')
const routeState: RouteState = {
  assignments: new Map(),
  audits: [],
  txQueries: [],
  auditFailure: false,
  exclusionAfterFirstWrite: false,
  writes: 0,
  nextId: 1,
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
      return (chunk as { queryChunks?: unknown[] })?.queryChunks ? sqlText(chunk) : ''
    })
    .join('')
}

;(globalThis as typeof globalThis & { openbooksRateBookSqlText?: typeof sqlText }).openbooksRateBookSqlText = sqlText

const mockSources = new Map<string, string>([
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.rate-book-assignment-route-test')]
      const sqlText = globalThis.openbooksRateBookSqlText
      const clone = (row) => ({ ...row })
      const first = (map) => map.values().next().value
      const primitiveChunks = (query) => (query.queryChunks || []).filter((chunk) => typeof chunk === 'string')
      const execute = async (query, local, pendingAudits) => {
        const text = sqlText(query)
        state.txQueries.push(text.replaceAll(/\\s+/g, ' ').trim())
        if (text.includes('select rate_book_id as')) {
          const row = first(local)
          return { rows: row ? [{ rateBookId: row.rate_book_id, customerId: row.customer_id, projectId: row.project_id,
            effectiveFrom: row.effective_from, effectiveTo: row.effective_to, dateBasis: row.date_basis, isActive: row.is_active }] : [] }
        }
        if (text.includes('select * from item_rate_book_assignments')) return { rows: first(local) ? [clone(first(local))] : [] }
        if (text.includes('item_rate_books b where') && text.includes('book_ok')) return { rows: [{ book_ok: true, customer_ok: true, project_ok: true }] }
        if (text.includes('select 1 from item_rate_book_assignments')) return { rows: [] }
        if (text.includes('insert into item_rate_book_assignments')) {
          state.writes += 1
          if (state.exclusionAfterFirstWrite && state.writes > 1) throw { cause: { code: '23P01' } }
          const id = '00000000-0000-0000-0000-00000000000' + state.nextId++
          const row = { id, org_id: 'org-1', rate_book_id: 'book-1', customer_id: 'customer-1', project_id: null,
            effective_from: '2026-01-01', effective_to: '2026-12-31', date_basis: 'usage_date', is_active: true,
            created_by: 'user-1', updated_by: 'user-1' }
          local.set(id, row)
          return { rows: [clone(row)] }
        }
        if (text.includes('update item_rate_book_assignments')) {
          state.writes += 1
          if (state.exclusionAfterFirstWrite && state.writes > 1) throw { code: '23P01' }
          const row = first(local)
          if (!row) return { rows: [] }
          const updated = { ...row, effective_from: '2027-01-01', updated_by: 'user-1' }
          local.set(row.id, updated)
          return { rows: [clone(updated)] }
        }
        if (text.includes('delete from item_rate_book_assignments')) {
          const row = first(local)
          if (!row) return { rows: [] }
          local.delete(row.id)
          return { rows: [{ id: row.id }] }
        }
        if (text.includes('insert into audit_log')) {
          if (state.auditFailure) throw new Error('forced audit failure')
          const values = primitiveChunks(query)
          const changes = JSON.parse(values.find((value) => value.startsWith('{')) || '{}')
          const action = text.includes("'insert'") ? 'insert' : text.includes("'update'") ? 'update' : 'delete'
          pendingAudits.push({ action, actorId: 'user-1', changes })
          return { rows: [] }
        }
        return { rows: [] }
      }
      export const db = {
        execute: async (query) => execute(query, state.assignments, []),
        transaction: async (work) => {
          const local = new Map([...state.assignments].map(([id, row]) => [id, clone(row)]))
          const pendingAudits = []
          try {
            const result = await work({ execute: (query) => execute(query, local, pendingAudits) })
            state.assignments = local
            state.audits.push(...pendingAudits)
            return result
          } catch (error) {
            throw error
          }
        },
      }
    `,
  ],
  ['mock:json', `export const jsonObject = {}; export async function parseJsonBody(request) { return { ok: true, data: await request.json() } }`],
  ['mock:authz', `export async function guardPermission() { return { user: { orgId: 'org-1', id: 'user-1' } } }; export function can() { return true }`],
  ['mock:features', `export async function isFeatureEnabled() { return true }`],
  ['mock:business-date', `export async function businessToday() { return '2026-08-26' }`],
  ['mock:list-params', `export function isUuid(value) { return typeof value === 'string' && value.length > 0 }`],
])

const mockUrls = new Map<string, string>([
  ['@openbooks/engine/src/db.ts', 'mock:db'],
  ['@openbooks/engine/src/business-date.ts', 'mock:business-date'],
  ['@/lib/api/json', 'mock:json'],
  ['../../../lib/authz', 'mock:authz'],
  ['../../../lib/features', 'mock:features'],
  ['../../../lib/list-params', 'mock:list-params'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?rate-book-assignment-transaction-test'
const route = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

const BOOK = '11111111-1111-1111-1111-111111111111'
const CUSTOMER = '22222222-2222-2222-2222-222222222222'

function reset(): void {
  routeState.assignments = new Map()
  routeState.audits = []
  routeState.txQueries = []
  routeState.auditFailure = false
  routeState.exclusionAfterFirstWrite = false
  routeState.writes = 0
  routeState.nextId = 1
}

function request(method: string, body?: Record<string, unknown>, id?: string): Request {
  const url = new URL('http://openbooks.test/api/rate-book-assignments')
  if (id) url.searchParams.set('id', id)
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
}

function assignmentBody(effectiveFrom: string, effectiveTo: string): Record<string, unknown> {
  return { rateBookId: BOOK, customerId: CUSTOMER, effectiveFrom, effectiveTo, dateBasis: 'usage_date', isActive: true }
}

function seed(): Assignment {
  const row: Assignment = {
    id: '33333333-3333-3333-3333-333333333333', org_id: 'org-1', rate_book_id: BOOK,
    customer_id: CUSTOMER, project_id: null, effective_from: '2026-01-01', effective_to: '2026-12-31',
    date_basis: 'usage_date', is_active: true, created_by: 'user-1', updated_by: 'user-1',
  }
  routeState.assignments.set(row.id, row)
  return row
}

test('nonoverlapping POST commits its assignment and immutable before/after audit', async () => {
  reset()
  const first = await route.POST(request('POST', assignmentBody('2026-01-01', '2026-06-30')))
  const second = await route.POST(request('POST', assignmentBody('2026-07-01', '2026-12-31')))
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.equal(routeState.assignments.size, 2)
  assert.equal(routeState.audits.length, 2)
  assert.equal(routeState.audits[0]!.actorId, 'user-1')
  assert.equal(routeState.audits[0]!.changes.before, null)
  assert.ok(routeState.audits[0]!.changes.after)
  assert.ok(routeState.txQueries.every((query) => query.length > 0))
})

test('concurrent overlapping POST and PATCH map exclusion violations to overlap', async () => {
  reset()
  routeState.exclusionAfterFirstWrite = true
  const posts = await Promise.all([
    route.POST(request('POST', assignmentBody('2026-01-01', '2026-12-31'))),
    route.POST(request('POST', assignmentBody('2026-01-01', '2026-12-31'))),
  ])
  assert.deepEqual(posts.map((response) => response.status).sort(), [200, 400])
  assert.equal((await posts.find((response) => response.status === 400)!.json()).errorCode, 'overlap')

  reset()
  seed()
  routeState.exclusionAfterFirstWrite = true
  const patches = await Promise.all([
    route.PATCH(request('PATCH', { id: '33333333-3333-3333-3333-333333333333', ...assignmentBody('2027-01-01', '2027-12-31') })),
    route.PATCH(request('PATCH', { id: '33333333-3333-3333-3333-333333333333', ...assignmentBody('2027-01-01', '2027-12-31') })),
  ])
  assert.deepEqual(patches.map((response) => response.status).sort(), [200, 400])
  assert.equal((await patches.find((response) => response.status === 400)!.json()).errorCode, 'overlap')
  assert.ok(routeState.txQueries.some((query) => query.includes('for update')))
})

test('audit failure rolls back POST, PATCH, and DELETE mutations', async () => {
  reset()
  routeState.auditFailure = true
  await assert.rejects(route.POST(request('POST', assignmentBody('2026-01-01', '2026-12-31'))), /forced audit failure/)
  assert.equal(routeState.assignments.size, 0)

  reset()
  const before = seed()
  routeState.auditFailure = true
  await assert.rejects(route.PATCH(request('PATCH', { id: before.id, ...assignmentBody('2027-01-01', '2027-12-31') })), /forced audit failure/)
  assert.deepEqual(routeState.assignments.get(before.id), before)

  reset()
  const deleted = seed()
  routeState.auditFailure = true
  await assert.rejects(route.DELETE(request('DELETE', undefined, deleted.id)), /forced audit failure/)
  assert.deepEqual(routeState.assignments.get(deleted.id), deleted)
})

test('DELETE records the complete locked before-state and a null after-state', async () => {
  reset()
  const before = seed()
  const response = await route.DELETE(request('DELETE', undefined, before.id))
  assert.equal(response.status, 200)
  assert.equal(routeState.assignments.size, 0)
  assert.ok(routeState.txQueries.some((query) => query.includes('select * from item_rate_book_assignments') && query.includes('for update')))
  assert.deepEqual(routeState.audits[0]!.changes, { before, after: null })
})
