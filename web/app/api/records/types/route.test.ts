import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Route-boundary suite for the canonical unsaved create contract: opening
// `?type=new` (or cancelling it) must write nothing — this endpoint runs only
// on explicit Save, keyed by Idempotency-Key exactly like POST /api/accounts.
// An exact retry replays (200); a changed payload on the same key, or a key
// colliding with another org's row, is a 409 that returns no row.
const stateKey = Symbol.for('openbooks.record-types-route-test')
const ORG_ID = '00000000-0000-4000-8000-00000000b001'
const USER_ID = '00000000-0000-4000-8000-00000000b002'
const OTHER_ORG = '00000000-0000-4000-8000-00000000b003'

interface TypeRow {
  id: string
  org_id: string
  key: string
}

interface RouteState {
  requestKey: string | null
  /** Rows by id across ALL orgs (the id primary key is global). */
  rows: Map<string, TypeRow>
  /** Captured insert-audit `after` images by request key. */
  auditAfter: Map<string, Record<string, unknown>>
  auditInserts: number
  transactionQueries: string[]
}

const state: RouteState = {
  requestKey: null,
  rows: new Map(),
  auditAfter: new Map(),
  auditInserts: 0,
  transactionQueries: [],
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

/**
 * Flatten a drizzle SQL chunk into raw text for deterministic fake replies.
 * Probed shape (drizzle-orm): SQL text lives in `{ value: ["..."] }`
 * wrappers; bound params are BARE chunk entries (strings, numbers, booleans,
 * null, arrays); identifiers are `{ value: "name" }`; nested fragments carry
 * their own `queryChunks`. Bare strings are never text, so text extraction
 * skips them.
 */
function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks
  if (!Array.isArray(chunks)) return ''
  return chunks
    .map((chunk) => {
      if (typeof chunk === 'string') return ''
      if (!chunk || typeof chunk !== 'object') return ''
      if (Array.isArray((chunk as { queryChunks?: unknown }).queryChunks)) {
        return sqlText(chunk)
      }
      const value = (chunk as { value?: unknown }).value
      if (typeof value === 'string') return value
      if (Array.isArray(value)) return value.filter((v) => typeof v === 'string').join('')
      return ''
    })
    .join('')
}

/**
 * Best-effort bound-param capture (see sqlText for the probed shape), so the
 * fake observes the real server-built snapshot (including the audit `after`
 * image) instead of mirroring request construction — the replay proof below
 * compares what the route actually persisted, not what the test sent.
 */
function paramsOf(query: unknown): unknown[] {
  const out: unknown[] = []
  const walk = (chunks: unknown): void => {
    if (!Array.isArray(chunks)) return
    for (const chunk of chunks) {
      if (!chunk || typeof chunk !== 'object') {
        if (
          typeof chunk === 'string' ||
          typeof chunk === 'number' ||
          typeof chunk === 'boolean' ||
          chunk === null
        ) {
          out.push(chunk)
        }
        continue
      }
      if (Array.isArray(chunk)) {
        out.push(...chunk)
        continue
      }
      const nested = (chunk as { queryChunks?: unknown }).queryChunks
      if (Array.isArray(nested)) {
        walk(nested)
        continue
      }
      if ('value' in chunk) {
        const v = (chunk as { value?: unknown }).value
        if (typeof v === 'string') out.push(v)
      }
    }
  }
  walk((query as { queryChunks?: unknown })?.queryChunks)
  return out
}

function sniffAudit(params: unknown[]): void {
  for (const param of params) {
    if (typeof param !== 'string') continue
    let parsed: unknown = null
    try {
      parsed = JSON.parse(param)
    } catch {
      continue
    }
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      (parsed as { before?: unknown }).before === null &&
      typeof (parsed as { after?: unknown }).after === 'object'
    ) {
      state.auditInserts += 1
      if (state.requestKey) {
        state.auditAfter.set(state.requestKey, (parsed as { after: Record<string, unknown> }).after)
      }
    }
  }
}

;(
  globalThis as typeof globalThis & Record<string, unknown>
).openbooksRecordTypesSqlText = sqlText
;(
  globalThis as typeof globalThis & Record<string, unknown>
).openbooksRecordTypesParamsOf = paramsOf
;(
  globalThis as typeof globalThis & Record<string, unknown>
).openbooksRecordTypesSniffAudit = sniffAudit

const mockSources = new Map<string, string>([
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.record-types-route-test')]
      const sqlText = globalThis.openbooksRecordTypesSqlText
      const paramsOf = globalThis.openbooksRecordTypesParamsOf
      const sniffAudit = globalThis.openbooksRecordTypesSniffAudit
      function respond(query) {
        const text = sqlText(query)
        const params = paramsOf(query)
        sniffAudit(params)
        if (text.includes('insert into custom_record_types')) {
          if (state.rows.has(state.requestKey)) return { rows: [] }
          const row = { id: state.requestKey, org_id: '${ORG_ID}', key: 'key' }
          for (const p of params) {
            if (typeof p === 'string' && /^[a-z][a-z0-9-]{1,63}$/.test(p) && p !== state.requestKey) { row.key = p; break }
          }
          state.rows.set(state.requestKey, row)
          return { rows: [{ id: state.requestKey }] }
        }
        if (text.includes('from audit_log')) {
          const after = state.requestKey ? state.auditAfter.get(state.requestKey) : undefined
          return { rows: after ? [{ after }] : [] }
        }
        if (text.includes('select 1 from custom_record_types')) {
          const wanted = params.find((p) => typeof p === 'string' && p !== '${ORG_ID}')
          const clash = [...state.rows.values()].some(
            (r) => r.org_id === '${ORG_ID}' && r.key === wanted && r.id !== state.requestKey,
          )
          return { rows: clash ? [{}] : [] }
        }
        if (text.includes('select key from custom_record_types')) {
          return {
            rows: [...state.rows.values()]
              .filter((r) => r.org_id === '${ORG_ID}' && r.id !== state.requestKey)
              .map((r) => ({ key: r.key })),
          }
        }
        if (text.includes('from custom_record_types')) {
          const row = state.requestKey ? state.rows.get(state.requestKey) : undefined
          return { rows: row && row.org_id === '${ORG_ID}' ? [{ id: row.id }] : [] }
        }
        return { rows: [] }
      }
      export const db = {
        execute: async (query) => respond(query),
        transaction: async (work) => work({
          execute: async (query) => {
            state.transactionQueries.push(sqlText(query))
            return respond(query)
          },
        }),
      }
      export const schema = {}
      export function withOrgTransaction(_orgId, work) { return work() }
      export async function withOrg(_orgId, work) { return work() }
      export async function withOrgContext(_orgId, work) { return work() }
      export async function withBypass(work) { return work() }
      export async function withBypassContext(_opts, work) { return work() }
      export const pool = {}
      export const env = {}
      export function registerRequestOrgResolver() {}
      export function currentRequestOrgResolver() { return null }
      export function ambientTenantOrgId() { return null }
    `,
  ],
  [
    'mock:authz',
    `export async function guardPermission(permission) {
       if (permission === 'records.manage_types') return { user: { orgId: '${ORG_ID}', id: '${USER_ID}' }, allowedSubsidiaryIds: null }
       return new Response(null, { status: 403 })
     }`,
  ],
])

const mockUrls = new Map<string, string>([
  ['@openbooks/engine/src/platform/db.ts', 'mock:db'],
  ['../../../../lib/authz', 'mock:authz'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier === '@/lib/api/json') {
      return {
        url: new URL('../../../../lib/api/json.ts', import.meta.url).href,
        shortCircuit: true,
      }
    }
    if (specifier === '@openbooks/engine/src/platform/canonical-json.ts') {
      return {
        url: new URL(
          '../../../../../engine/src/platform/canonical-json.ts',
          import.meta.url,
        ).href,
        shortCircuit: true,
      }
    }
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

const routeUrl = './route.ts?record-types-idempotency-test'
const { POST } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function reset(): void {
  state.requestKey = null
  state.rows.clear()
  state.auditAfter.clear()
  state.auditInserts = 0
  state.transactionQueries.length = 0
}

function post(
  key: string | null,
  body: Record<string, unknown>,
): Promise<Response> {
  state.requestKey = key
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (key !== null) headers['Idempotency-Key'] = key
  return POST(
    new Request('http://openbooks.test/api/records/types', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
  )
}

const BODY = {
  name: 'Equipment item',
  pluralName: 'Equipment items',
  key: 'equipment-item',
  iconKey: 'grid',
  description: null,
  fields: [],
  showInNav: false,
  allowedRoles: null,
  sortOrder: 0,
}

test('type create refuses a missing or malformed idempotency key before any write', async () => {
  reset()

  const missing = await post(null, BODY)
  assert.equal(missing.status, 400)
  assert.deepEqual(await missing.json(), { error: 'invalid_idempotency_key' })

  const malformed = await post('not-a-uuid', BODY)
  assert.equal(malformed.status, 400)
  assert.deepEqual(await malformed.json(), { error: 'invalid_idempotency_key' })

  assert.equal(
    state.transactionQueries.length,
    0,
    'refused keys must not reach the database at all',
  )
})

test('type create refuses a non-object body through the shared boundary', async () => {
  reset()

  const response = await POST(
    new Request('http://openbooks.test/api/records/types', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': '00000000-0000-4000-8000-00000000b010',
      },
      body: '[1,2]',
    }),
  )
  assert.equal(response.status, 400)
})

test('type create validates name, key, and fields before inserting', async () => {
  reset()
  const key = '00000000-0000-4000-8000-00000000b011'

  const unnamed = await post(key, { ...BODY, name: '   ' })
  assert.equal(unnamed.status, 422)
  assert.deepEqual(await unnamed.json(), { error: 'Name must be 1–200 characters' })

  const badKey = await post(key, { ...BODY, key: 'Has Spaces!' })
  assert.equal(badKey.status, 422)
  const badKeyBody = (await badKey.json()) as { error: string }
  assert.match(badKeyBody.error, /Key must be/)

  const badFields = await post(key, {
    ...BODY,
    fields: [{ id: 'x' }],
  })
  assert.equal(badFields.status, 422)
  const badFieldsBody = (await badFields.json()) as { error: string }
  assert.match(badFieldsBody.error, /Invalid fields/)
  assert.equal(state.rows.size, 0, 'validation failures must not insert')
})

test('type create pins a caller-supplied key clash as a 409 naming the key', async () => {
  reset()
  state.rows.set('00000000-0000-4000-8000-00000000b099', {
    id: '00000000-0000-4000-8000-00000000b099',
    org_id: ORG_ID,
    key: 'equipment-item',
  })

  const clash = await post('00000000-0000-4000-8000-00000000b012', BODY)
  assert.equal(clash.status, 409)
  assert.deepEqual(await clash.json(), {
    error: 'A record type with key "equipment-item" already exists',
  })
})

test('type creation replays only the exact request for an idempotency key', async () => {
  reset()
  const key = '00000000-0000-4000-8000-00000000b013'

  const created = await post(key, BODY)
  assert.equal(created.status, 201)
  assert.deepEqual(await created.json(), { id: key })
  assert.equal(state.auditInserts, 1, 'the create must leave exactly one insert audit event')

  const replay = await post(key, BODY)
  assert.equal(replay.status, 200)
  assert.deepEqual(await replay.json(), { id: key })
  assert.equal(state.auditInserts, 1, 'a replay must not write a second audit event')

  const changed = await post(key, { ...BODY, name: 'Changed name' })
  assert.equal(changed.status, 409)
  assert.deepEqual(await changed.json(), { error: 'invalid_idempotency_key' })
})

test('type create refuses a key colliding with another org without disclosing it', async () => {
  reset()
  const key = '00000000-0000-4000-8000-00000000b014'
  state.rows.set(key, { id: key, org_id: OTHER_ORG, key: 'foreign-type' })

  const response = await post(key, BODY)
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: 'invalid_idempotency_key' })
  assert.equal(state.auditInserts, 0, 'a foreign collision must not audit in this org')
})
