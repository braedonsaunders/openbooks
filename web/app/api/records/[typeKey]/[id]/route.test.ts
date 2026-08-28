import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Route boundary suite for custom-record lifecycle writes. The fake database
// models a tenant-pinned transaction: writes stay pending until the callback
// commits, an audit failure restores the before-image, and concurrent calls
// queue behind the row lock. This exercises PATCH and DELETE through the real
// route entry points rather than merely checking source text.
const stateKey = Symbol.for('openbooks.custom-record-route-test')
const ORG_ID = '00000000-0000-4000-8000-00000000c001'
const USER_ID = '00000000-0000-4000-8000-00000000c002'
const RECORD_ID = '00000000-0000-4000-8000-00000000c003'
const TYPE_ID = '00000000-0000-4000-8000-00000000c004'
const TYPE_KEY = 'certification'

type StoredRecord = Record<string, unknown> & {
  id: string
  type_id: string
  type_key: string
  record_number: string
  data: Record<string, unknown>
  status: 'draft' | 'active' | 'inactive'
  created_at: string
  created_by: string
  updated_at: string
  updated_by: string
  search_text: string
}

interface AuditCall {
  orgId: string | null
  table: string
  rowId: string
  action: string
  changes: Record<string, unknown>
  actorId: string
  at: string
}

interface RouteState {
  record: StoredRecord | null
  calls: Array<{ transaction: boolean; text: string }>
  audits: AuditCall[]
  pendingAudits: AuditCall[]
  pendingRecord: StoredRecord | null
  inTransaction: boolean
  failAudit: boolean
  sequence: number
  transactionTail: Promise<void>
  transactionOrgs: string[]
}

const initialRecord = (): StoredRecord => ({
  id: RECORD_ID,
  type_id: TYPE_ID,
  type_key: TYPE_KEY,
  record_number: 'CER-000001',
  data: { name: 'Original certification' },
  status: 'draft',
  created_at: '2026-08-28T12:00:00.000Z',
  created_by: USER_ID,
  updated_at: '2026-08-28T12:00:00.000Z',
  updated_by: USER_ID,
  search_text: 'cer-000001 original certification',
})

const state: RouteState = {
  record: initialRecord(),
  calls: [],
  audits: [],
  pendingAudits: [],
  pendingRecord: null,
  inTransaction: false,
  failAudit: false,
  sequence: 0,
  transactionTail: Promise.resolve(),
  transactionOrgs: [],
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

function clone<T>(value: T): T {
  return structuredClone(value)
}

/** Flatten a drizzle SQL chunk into the raw text used by the scripted DB. */
function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks
  if (!Array.isArray(chunks)) return ''
  return chunks
    .map((chunk) => {
      if (typeof chunk === 'string') return chunk
      const value = (chunk as { value?: unknown[] })?.value
      if (Array.isArray(value)) return value.map(String).join('')
      if ((chunk as { queryChunks?: unknown[] })?.queryChunks) return sqlText(chunk)
      return typeof chunk === 'number' ? String(chunk) : ''
    })
    .join('')
}
;(globalThis as typeof globalThis & Record<string, unknown>).openbooksCustomRecordSqlText = sqlText

const mockSources = new Map<string, string>([
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.custom-record-route-test')]
      const sqlText = globalThis.openbooksCustomRecordSqlText
      const copy = (value) => value == null ? value : structuredClone(value)
      const execute = async (query) => {
        const text = sqlText(query)
        state.calls.push({ transaction: state.inTransaction, text })
        if (text.includes('select * from custom_records') && text.includes('for update')) {
          return { rows: state.pendingRecord ? [copy(state.pendingRecord)] : [] }
        }
        if (text.includes('select id, name, base_currency from orgs')) {
          return { rows: [{ id: 'org-1', name: 'Acme', base_currency: 'CAD' }] }
        }
        if (text.includes('update custom_records')) {
          if (!state.pendingRecord) return { rows: [] }
          const data = text.match(/data = coalesce\\((\\{.*\\})::jsonb/)?.[1]
          if (data) state.pendingRecord.data = JSON.parse(data)
          const status = text.match(/status = coalesce\\(([^,]*), status\\)/)?.[1]?.trim()
          if (status) state.pendingRecord.status = status
          state.sequence += 1
          state.pendingRecord.updated_by = '00000000-0000-4000-8000-00000000c002'
          state.pendingRecord.updated_at = '2026-08-28T12:00:00.' + String(state.sequence).padStart(3, '0') + 'Z'
          const search = text.match(/search_text = coalesce\\(([^,]*), search_text\\)/)?.[1]?.trim()
          if (search) state.pendingRecord.search_text = search
          return { rows: [copy(state.pendingRecord)] }
        }
        if (text.includes('delete from custom_records')) {
          if (!state.pendingRecord) return { rows: [] }
          const deleted = copy(state.pendingRecord)
          state.pendingRecord = null
          return { rows: [deleted] }
        }
        throw new Error('unexpected database query: ' + text)
      }
      export const db = { execute }
      export async function withOrgTransaction(_orgId, work) {
        state.transactionOrgs.push(_orgId)
        const prior = state.transactionTail
        let release
        state.transactionTail = new Promise((resolve) => { release = resolve })
        await prior
        const before = copy(state.record)
        state.pendingRecord = copy(state.record)
        state.pendingAudits = []
        state.inTransaction = true
        try {
          const result = await work()
          state.record = copy(state.pendingRecord)
          state.audits.push(...state.pendingAudits.map(copy))
          return result
        } catch (error) {
          state.record = before
          throw error
        } finally {
          state.pendingRecord = null
          state.pendingAudits = []
          state.inTransaction = false
          release()
        }
      }
    `,
  ],
  [
    'mock:authz',
    `
      export async function guardPermission(permission) {
        if (permission !== 'records.read' && permission !== 'records.create') throw new Error('unexpected permission: ' + permission)
        return { user: { orgId: '${ORG_ID}', id: '${USER_ID}', name: 'Actor', roles: [{ key: 'admin' }] } }
      }
    `,
  ],
  [
    'mock:records',
    `
      const state = globalThis[Symbol.for('openbooks.custom-record-route-test')]
      const copy = (value) => value == null ? value : structuredClone(value)
      export async function loadRecordTypeByKey() {
        return { id: '${TYPE_ID}', key: '${TYPE_KEY}', name: 'Certification', plural_name: 'Certifications', fields: [], status: 'published', allowed_roles: null }
      }
      export async function loadRecord() { return copy(state.record) }
      export function inTypeAudience() { return true }
      export async function buildSearchText(_sections, data, number) { return number.toLowerCase() + ' ' + JSON.stringify(data).toLowerCase() }
    `,
  ],
  [
    'mock:record-schema',
    `
      export function lintRecordFields() { return { success: true, sections: [{ id: 'header', repeating: false, fields: [{ id: 'name', type: 'text' }] }] } }
      export function stripUnknownData(_sections, data) { return data }
      export function withComputedFormulas(_sections, data) { return data }
      export function validateRecordData() { return [] }
    `,
  ],
  [
    'mock:scripting',
    `
      export async function runTriggerScripts() { return [] }
    `,
  ],
  [
    'mock:audit',
    `
      const state = globalThis[Symbol.for('openbooks.custom-record-route-test')]
      const copy = (value) => structuredClone(value)
      export async function auditSetupChange(args) {
        if (state.failAudit) throw new Error('forced audit failure')
        // audit_log.at has a database default; model that immutable timestamp
        // in the executable harness so callers cannot omit temporal evidence.
        state.pendingAudits.push({ ...copy(args), at: new Date().toISOString() })
      }
    `,
  ],
  [
    'mock:json',
    `
      export const jsonObject = {}
      export async function parseJsonBody(request) {
        const body = await request.json().catch(() => undefined)
        if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, response: new Response(JSON.stringify({ error: 'invalid request body' }), { status: 400 }) }
        return { ok: true, data: body }
      }
    `,
  ],
  ['mock:list-params', `export function isUuid(value) { return value === '${RECORD_ID}' }`],
])

const mockUrls = new Map<string, string>([
  ['@openbooks/engine/src/db.ts', 'mock:db'],
  ['@openbooks/engine/src/scripting.ts', 'mock:scripting'],
  ['@/lib/api/json', 'mock:json'],
  ['../../../../../lib/authz', 'mock:authz'],
  ['../../../../../lib/list-params', 'mock:list-params'],
  ['../../../../../lib/records', 'mock:records'],
  ['../../../../../lib/record-schema', 'mock:record-schema'],
  ['../../../../../lib/setup/audit', 'mock:audit'],
])

const hooks = registerHooks({
  resolve(specifier, _context, nextResolve) {
    if (specifier === 'server-only') return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    return nextResolve(specifier, _context)
  },
  load(url, _context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, _context)
  },
})

const routeUrl = './route.ts?custom-record-route-test'
const { PATCH, DELETE } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function reset(record: StoredRecord = initialRecord()): void {
  state.record = clone(record)
  state.calls = []
  state.audits = []
  state.pendingAudits = []
  state.pendingRecord = null
  state.inTransaction = false
  state.failAudit = false
  state.sequence = 0
  state.transactionTail = Promise.resolve()
  state.transactionOrgs = []
}

function patch(body: Record<string, unknown>): Promise<Response> {
  return PATCH(
    new Request(`http://openbooks.test/api/records/${TYPE_KEY}/${RECORD_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ typeKey: TYPE_KEY, id: RECORD_ID }) },
  )
}

function remove(reason?: string): Promise<Response> {
  const init: RequestInit = { method: 'DELETE' }
  if (reason !== undefined) {
    init.headers = { 'content-type': 'application/json' }
    init.body = JSON.stringify({ reason })
  }
  return DELETE(
    new Request(`http://openbooks.test/api/records/${TYPE_KEY}/${RECORD_ID}`, init),
    { params: Promise.resolve({ typeKey: TYPE_KEY, id: RECORD_ID }) },
  )
}

function audit(action: string): AuditCall {
  const event = state.audits.find((entry) => entry.action === action)
  assert.ok(event, `the ${action} mutation committed audit evidence`)
  return event
}

test('PATCH updates data and lifecycle status with a complete immutable before/after audit', async () => {
  reset()

  const response = await patch({ data: { name: 'Renewed certification' }, status: 'active', reason: 'annual renewal' })

  assert.equal(response.status, 200)
  assert.equal(state.record?.status, 'active')
  assert.deepEqual(state.record?.data, { name: 'Renewed certification' })
  assert.deepEqual(state.transactionOrgs, [ORG_ID], 'the mutation is pinned to the actor tenant')
  assert.ok(state.calls.some((call) => call.transaction && call.text.includes('for update')), 'PATCH locks the record in the tenant transaction')
  const event = audit('update')
  assert.equal(event.orgId, ORG_ID)
  assert.equal(event.table, 'custom_records')
  assert.equal(event.rowId, RECORD_ID)
  assert.equal(event.actorId, USER_ID)
  assert.match(event.at, /^\d{4}-\d{2}-\d{2}T/, 'audit evidence carries an immutable timestamp')
  assert.equal(event.changes.operation, 'lifecycle')
  assert.equal(event.changes.reason, 'annual renewal')
  assert.deepEqual((event.changes.before as StoredRecord).data, { name: 'Original certification' })
  assert.equal((event.changes.before as StoredRecord).status, 'draft')
  assert.deepEqual((event.changes.after as StoredRecord).data, { name: 'Renewed certification' })
  assert.equal((event.changes.after as StoredRecord).status, 'active')
})

test('audit failure rolls back a data update and lifecycle transition', async () => {
  reset()
  state.failAudit = true

  await assert.rejects(() => patch({ data: { name: 'Must not persist' }, status: 'active', reason: 'failed audit' }), /forced audit failure/)

  assert.deepEqual(state.record, initialRecord(), 'the row remains unchanged when its evidence cannot be written')
  assert.equal(state.audits.length, 0, 'no orphan audit event committed')
  assert.ok(state.calls.some((call) => call.text.includes('update custom_records')), 'the mutation was attempted inside the transaction')
})

test('audit failure rolls back deactivation without changing the active record', async () => {
  reset({ ...initialRecord(), status: 'active' })
  state.failAudit = true

  await assert.rejects(() => patch({ status: 'inactive', reason: 'retired' }), /forced audit failure/)

  assert.equal(state.record?.status, 'active', 'the lifecycle transition rolls back with its missing evidence')
  assert.equal(state.audits.length, 0)
})

test('concurrent PATCH calls serialize before-images behind the row lock', async () => {
  reset({ ...initialRecord(), status: 'active' })

  const first = patch({ data: { name: 'First writer' }, reason: 'first' })
  const second = patch({ data: { name: 'Second writer' }, reason: 'second' })
  const responses = await Promise.all([first, second])

  assert.deepEqual(responses.map((response) => response.status), [200, 200])
  assert.equal(state.audits.length, 2)
  const [firstAudit, secondAudit] = state.audits
  assert.deepEqual((firstAudit!.changes.before as StoredRecord).data, { name: 'Original certification' })
  assert.deepEqual((firstAudit!.changes.after as StoredRecord).data, { name: 'First writer' })
  assert.deepEqual((secondAudit!.changes.before as StoredRecord).data, { name: 'First writer' })
  assert.deepEqual((secondAudit!.changes.after as StoredRecord).data, { name: 'Second writer' })
  assert.equal(state.record?.data.name, 'Second writer')
})

test('DELETE captures the locked draft before-image and reason atomically', async () => {
  reset()

  const response = await remove('duplicate draft')

  assert.equal(response.status, 200)
  assert.equal(state.record, null)
  assert.ok(state.calls.some((call) => call.transaction && call.text.includes('for update')), 'DELETE locks the draft before erasing it')
  const event = audit('delete')
  assert.equal(event.actorId, USER_ID)
  assert.equal(event.changes.operation, 'delete')
  assert.equal(event.changes.reason, 'duplicate draft')
  assert.deepEqual((event.changes.before as StoredRecord).data, { name: 'Original certification' })
  assert.equal(event.changes.after, null)
})

test('audit failure rolls back a draft deletion', async () => {
  reset()
  state.failAudit = true

  await assert.rejects(() => remove('failed deletion'), /forced audit failure/)

  assert.deepEqual(state.record, initialRecord(), 'the draft remains available after an audit outage')
  assert.equal(state.audits.length, 0)
  assert.ok(state.calls.some((call) => call.text.includes('delete from custom_records')), 'the delete was attempted inside the transaction')
})
