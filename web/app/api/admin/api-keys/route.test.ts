import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Route boundary suite for /api/admin/api-keys (same scripted-database
// harness as /api/payments/[id]). It pins the two security contracts of the
// module: every security mutation commits together with its audit_log
// evidence (an audit failure must roll the mutation back), and revocation is
// terminal — a revoked credential can never authenticate again and cannot be
// reactivated through the API, while a merely suspended key follows an
// explicit audited resume path.
const stateKey = Symbol.for('openbooks.api-keys-route-test')
interface ApiKeysRouteState {
  /** Every statement the route issued, in order (reads included). */
  executed: string[]
  /** Write statements that survived a committed unit. */
  committed: string[]
  /** Writes buffered inside the currently-open transaction. */
  pending: string[]
  inTx: boolean
  /** When set, matching statements reject — models storage failures. */
  failOnText?: string
  /** Row returned for `select … from api_keys` lookups. */
  keyRow: Record<string, unknown> | null
  /** Whether the append-only revocation ('delete') audit record exists. */
  revocationRecorded: boolean
}
const state: ApiKeysRouteState = {
  executed: [],
  committed: [],
  pending: [],
  inTx: false,
  keyRow: null,
  revocationRecorded: false,
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

/** Flatten a drizzle SQL chunk into its raw text for routing scripted replies. */
function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks
  if (!Array.isArray(chunks)) return ''
  return chunks
    .map((c) => {
      if (typeof c === 'string') return c
      const value = (c as { value?: unknown[] })?.value
      if (Array.isArray(value)) return value.map(String).join('')
      if ((c as { queryChunks?: unknown[] })?.queryChunks) return sqlText(c)
      return ''
    })
    .join('')
}
;(globalThis as typeof globalThis & Record<string, unknown>).openbooksSqlTextApiKeys = sqlText

const ORG_ID = '00000000-0000-4000-8000-00000000a001'
const USER_ID = '00000000-0000-4000-8000-00000000a002'
const KEY_ID = '00000000-0000-4000-8000-00000000a003'

const mockSources = new Map<string, string>([
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.api-keys-route-test')]
      const sqlText = globalThis.openbooksSqlTextApiKeys
      const isWrite = (text) =>
        text.includes('insert into api_keys') ||
        text.includes('insert into audit_log') ||
        text.includes('update api_keys')
      export const db = {
        async execute(query) {
          const text = sqlText(query)
          state.executed.push(text)
          if (state.failOnText && text.includes(state.failOnText)) {
            throw new Error('forced storage failure: ' + state.failOnText)
          }
          if (!isWrite(text)) {
            if (text.includes('from audit_log')) {
              return { rows: state.revocationRecorded ? [{ one: 1 }] : [] }
            }
            if (text.includes('from api_keys')) {
              return { rows: state.keyRow ? [state.keyRow] : [] }
            }
          }
          const ledger = state.inTx ? state.pending : state.committed
          ledger.push(text)
          if (text.includes('insert into api_keys')) return { rows: [{ id: '${KEY_ID}' }] }
          return { rows: [] }
        },
        transaction: async (work) => work({}),
      }
      export async function withOrgTransaction(_orgId, work) {
        if (state.inTx) return work()
        state.inTx = true
        state.pending = []
        try {
          const result = await work()
          state.committed.push(...state.pending)
          return result
        } finally {
          state.inTx = false
          state.pending = []
        }
      }
      export async function withOrg(_orgId, work) { return work() }
      export async function withOrgContext(_orgId, work) { return work() }
      export async function withBypass(work) { return work() }
      export async function withBypassContext(_opts, work) { return work() }
      export const pool = {}
      export const env = {}
      export const schema = {}
      export function registerRequestOrgResolver() {}
    `,
  ],
  [
    'mock:feature-gates',
    `
      export async function guardFeaturePermission() {
        return { user: { orgId: '${ORG_ID}', id: '${USER_ID}' } }
      }
    `,
  ],
  [
    'mock:api-auth',
    `
      import { createHash, randomBytes } from 'node:crypto'
      export function generateApiKey() {
        const secret = randomBytes(32).toString('base64url')
        const plaintext = 'ob_live_' + secret
        return {
          plaintext,
          keyHash: createHash('sha-256').update(plaintext, 'utf8').digest('hex'),
          keyPrefix: plaintext.slice(0, 12),
          keyPreview: secret.slice(-4),
        }
      }
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['@openbooks/engine/src/db.ts', 'mock:db'],
  ['../../../../lib/feature-gates', 'mock:feature-gates'],
  ['../../../../lib/api-auth', 'mock:api-auth'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    // The web tsconfig maps '@/…' to the web root; the plain runner needs the
    // mapping spelled out.
    if (specifier.startsWith('@/')) {
      return {
        url: new URL(`${specifier.slice(2)}.ts`, new URL('../../../../', import.meta.url)).href,
        shortCircuit: true,
        format: 'module',
      }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) {
      return { format: 'module', source, shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?api-keys-route-test'
const { POST, PATCH, DELETE } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function reset(): void {
  state.executed = []
  state.committed = []
  state.pending = []
  state.inTx = false
  state.failOnText = undefined
  state.keyRow = null
  state.revocationRecorded = false
}

function post(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request('http://openbooks.test/api/admin/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

function patchKey(body: Record<string, unknown>): Promise<Response> {
  return PATCH(
    new Request('http://openbooks.test/api/admin/api-keys', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

function revokeKey(id: string): Promise<Response> {
  return DELETE(
    new Request('http://openbooks.test/api/admin/api-keys', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    }),
  )
}

const revokedKeyRow = () => ({
  id: KEY_ID,
  name: 'ci key',
  description: null,
  scopes: [],
  rate_limit_per_min: 120,
  is_active: false,
})

test('create returns the plaintext once and commits the key with its audit evidence', async () => {
  reset()

  const response = await post({ name: 'sync key', scopes: ['gl.read'], rateLimitPerMin: 60 })

  assert.equal(response.status, 201)
  const payload = (await response.json()) as { id: string; plaintext: string }
  assert.equal(payload.id, KEY_ID)
  assert.match(payload.plaintext, /^ob_live_/)
  assert.ok(
    state.committed.some((t) => t.includes('insert into api_keys')),
    'the key row committed',
  )
  const audit = state.committed.find((t) => t.includes('insert into audit_log'))
  assert.ok(audit, 'the audit evidence committed in the same unit')
  assert.match(audit, /"before":null/, 'creation evidence identifies the prior state')
  assert.match(audit, /"after":/, 'creation evidence identifies the resulting state')
  assert.match(audit, new RegExp(USER_ID), 'creation evidence identifies the actor')
  assert.equal(audit.includes(payload.plaintext), false, 'audit evidence never contains the secret')
})

test('create rejects omitted or empty scopes before opening a transaction', async () => {
  for (const body of [{ name: 'omitted scopes' }, { name: 'empty scopes', scopes: [] }]) {
    reset()

    const response = await post(body)

    assert.equal(response.status, 400)
    assert.match((await response.json()).error, /at least one scope is required/)
    assert.deepEqual(state.executed, [], 'invalid scope sets never reach storage')
  }
})

test('update rejects clearing a key to an empty scope set before opening a transaction', async () => {
  reset()

  const response = await patchKey({ id: KEY_ID, scopes: [] })

  assert.equal(response.status, 400)
  assert.match((await response.json()).error, /at least one scope is required/)
  assert.deepEqual(state.executed, [], 'invalid scope sets never reach storage')
})

test('a forced audit failure leaves no created key or leaked plaintext behind', async () => {
  reset()
  state.failOnText = 'insert into audit_log'

  await assert.rejects(() => post({ name: 'doomed key', scopes: ['gl.read'] }), /forced storage failure/)

  assert.ok(
    state.executed.some((t) => t.includes('insert into api_keys')),
    'the mutation was attempted inside the unit',
  )
  assert.equal(
    state.committed.some((t) => t.includes('insert into api_keys')),
    false,
    'the rolled-back key row never reached storage',
  )
  assert.equal(
    state.committed.some((t) => t.includes('insert into audit_log')),
    false,
    'nothing half-committed',
  )
})

test('a revoked key refuses reactivation and no update reaches storage', async () => {
  reset()
  state.keyRow = revokedKeyRow()
  state.revocationRecorded = true

  const response = await patchKey({ id: KEY_ID, isActive: true })

  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), {
    error: 'this key was revoked; revocation is permanent — create a new key',
  })
  assert.equal(
    state.committed.some((t) => t.includes('update api_keys')),
    false,
    'the refused reactivation never wrote',
  )
})

test('a suspended (never revoked) key resumes through an explicit audited update', async () => {
  reset()
  state.keyRow = revokedKeyRow()
  state.revocationRecorded = false

  const response = await patchKey({ id: KEY_ID, isActive: true })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  assert.ok(state.committed.some((t) => t.includes('update api_keys')))
  assert.ok(
    state.committed.some((t) => t.includes('insert into audit_log')),
    'the resume is audited',
  )
})

test('revocation destroys the stored credential material so the secret can never authenticate again', async () => {
  reset()
  state.keyRow = { id: KEY_ID, name: 'leaked key', key_prefix: 'ob_live_deadbee', is_active: true }

  const response = await revokeKey(KEY_ID)

  assert.equal(response.status, 200)
  const update = state.committed.find((t) => t.includes('update api_keys'))
  assert.ok(update, 'the revocation update committed')
  assert.match(update!, /is_active = false/)
  assert.match(update!, /key_hash/, 'the original hash is replaced — the old secret can never resolve again')
  assert.match(update!, /key_preview/, 'the preview of the destroyed secret is replaced too')
  assert.ok(
    state.committed.some((t) => t.includes('insert into audit_log')),
    'the revocation evidence committed in the same unit',
  )
})
