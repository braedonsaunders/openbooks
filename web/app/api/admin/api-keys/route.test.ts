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
  /** The session actor's own effective permissions (the grant ceiling). */
  actorPermissions: string[]
  /** The session actor's subsidiary lens; null = unrestricted. */
  actorLens: string[] | null
  /** Super admins are exempt from the ceiling, like admin.users.manage. */
  actorSuperAdmin: boolean
  /** Owner role permission sets for the use-time authority resolution. */
  ownerRoleRows: Array<{ permissions: unknown }>
  /** Owner permission overrides for the use-time authority resolution. */
  ownerOverrides: Array<{ permission: string; effect: 'grant' | 'deny' }>
  /** Owner identity row for the trusted lens resolution. */
  ownerIdentity: { isSuperAdmin: boolean; isActive: boolean }
  /** Owner role subsidiary restrictions for the trusted lens resolution. */
  ownerRestrictions: Array<{ restriction: unknown }>
  /** Subsidiary rows for subtree lens expansion. */
  subsidiaries: Array<{ id: string; parentId: string | null }>
}
const state: ApiKeysRouteState = {
  executed: [],
  committed: [],
  pending: [],
  inTx: false,
  keyRow: null,
  revocationRecorded: false,
  actorPermissions: [],
  actorLens: null,
  actorSuperAdmin: false,
  ownerRoleRows: [],
  ownerOverrides: [],
  ownerIdentity: { isSuperAdmin: false, isActive: true },
  ownerRestrictions: [{ restriction: { mode: 'all' } }],
  subsidiaries: [],
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
const OWNER_ID = '00000000-0000-4000-8000-00000000a004'
const SUB_A = '00000000-0000-4000-8000-00000000b00a'
const SUB_B = '00000000-0000-4000-8000-00000000b00b'

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
            // Owner authority resolution (the same reads resolveApiKeyAuth
            // performs at use time): role permission sets, then overrides.
            // The subsidiary-restriction read is matched first — it shares
            // the role_assignments table with the permission read.
            if (text.includes('subsidiary_restriction')) {
              return { rows: state.ownerRestrictions }
            }
            if (text.includes('from role_assignments')) {
              return { rows: state.ownerRoleRows }
            }
            if (text.includes('from user_permission_overrides')) {
              return { rows: state.ownerOverrides }
            }
            if (text.includes('from users')) {
              return { rows: [{ isSuperAdmin: state.ownerIdentity.isSuperAdmin, isActive: state.ownerIdentity.isActive }] }
            }
            if (text.includes('from subsidiaries')) {
              return { rows: state.subsidiaries }
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
      // The real withBypassContext takes the work alone; support both arities
      // so engine helpers (actorIdentity) run against the scripted store.
      export async function withBypassContext(first, second) {
        const work = typeof second === 'function' ? second : first
        return work()
      }
      export const pool = {}
      export const env = {}
      export const schema = {}
      export function registerRequestOrgResolver() {}
    `,
  ],
  [
    'mock:feature-gates',
    `
      const state = globalThis[Symbol.for('openbooks.api-keys-route-test')]
      export async function guardFeaturePermission() {
        return {
          user: { orgId: '${ORG_ID}', id: '${USER_ID}', isSuperAdmin: state.actorSuperAdmin },
          permissions: new Set(state.actorPermissions),
          allowedSubsidiaryIds: state.actorLens === null ? null : new Set(state.actorLens),
        }
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
  ['@openbooks/engine/src/platform/db.ts', 'mock:db'],
  // Engine-internal relative import of the same store (actor-subsidiaries →
  // actor-permissions → platform/db). Only the I/O seam is mocked; the
  // permission and subsidiary-scope derivation stays real.
  ['../platform/db.ts', 'mock:db'],
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
  state.actorPermissions = ['gl.read', 'ar.read', 'api.keys.manage']
  state.actorLens = null
  state.actorSuperAdmin = false
  state.ownerRoleRows = []
  state.ownerOverrides = []
  state.ownerIdentity = { isSuperAdmin: false, isActive: true }
  state.ownerRestrictions = [{ restriction: { mode: 'all' } }]
  state.subsidiaries = []
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
  user_id: OWNER_ID,
  name: 'ci key',
  description: null,
  scopes: [],
  rate_limit_per_min: 120,
  is_active: false,
})

/** A live key owned by someone other than the session actor. */
const ownedKeyRow = (scopes: string[], isActive = true) => ({
  id: KEY_ID,
  user_id: OWNER_ID,
  name: 'owner key',
  description: null,
  scopes,
  rate_limit_per_min: 120,
  is_active: isActive,
})

function committedWrites(): string[] {
  return state.committed.filter(
    (t) => t.includes('insert into api_keys') || t.includes('update api_keys') || t.includes('insert into audit_log'),
  )
}

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

test('update rejects a non-boolean isActive before opening a transaction', async () => {
  for (const isActive of ['true', 1, 0]) {
    reset()

    const response = await patchKey({ id: KEY_ID, isActive })

    assert.equal(response.status, 400)
    assert.match((await response.json()).error, /isActive must be a boolean/)
    assert.deepEqual(state.executed, [], 'a type-confused flag never reaches storage')
  }
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
  assert.ok(
    state.committed.some((t) => t.includes('insert into audit_log')),
    'the revocation evidence committed in the same unit',
  )
})

test('create refuses scopes above the editor’s own authority before touching storage', async () => {
  reset()
  state.actorPermissions = ['ar.read', 'api.keys.manage']

  const response = await post({ name: 'escalated key', scopes: ['ar.read', 'payroll.read'] })

  assert.equal(response.status, 403)
  const payload = (await response.json()) as { error: string; missing: string[] }
  assert.match(payload.error, /cannot grant permissions you do not hold: payroll\.read/)
  assert.deepEqual(payload.missing, ['payroll.read'])
  assert.match(payload.error, /ask an administrator who holds them/)
  assert.deepEqual(committedWrites(), [], 'the refused grant wrote nothing')
  assert.equal(
    state.executed.some((t) => t.includes('insert into api_keys')),
    false,
    'the refused grant never reached storage',
  )
})

test('create grants scopes the editor holds, including a wildcard-covered one', async () => {
  reset()
  state.actorPermissions = ['ar.*', 'api.keys.manage']

  const response = await post({ name: 'covered key', scopes: ['ar.read'] })

  assert.equal(response.status, 201)
  assert.ok(state.committed.some((t) => t.includes('insert into api_keys')))
})

test('a key-manager cannot widen another owner’s key with a scope they do not hold', async () => {
  reset()
  // A manager holding only the key admin grant plus ar.read: the key belongs
  // to a different owner, so the use-time intersection (key ∩ OWNER) would
  // amplify payroll.read into real authority.
  state.actorPermissions = ['ar.read', 'api.keys.manage']
  state.keyRow = ownedKeyRow(['ar.read'])
  state.ownerRoleRows = [{ permissions: ['ar.read', 'payroll.read'] }]

  const response = await patchKey({ id: KEY_ID, scopes: ['ar.read', 'payroll.read'] })

  assert.equal(response.status, 403)
  const payload = (await response.json()) as { error: string; missing: string[] }
  assert.match(payload.error, /cannot grant permissions you do not hold: payroll\.read/)
  assert.deepEqual(payload.missing, ['payroll.read'])
  assert.deepEqual(committedWrites(), [], 'the refused widening wrote nothing')
  // The stored grant is read back unchanged: the token still authorizes only
  // the original selection.
  assert.deepEqual((state.keyRow as { scopes: string[] }).scopes, ['ar.read'])
  assert.equal(
    state.executed.some((t) => t.includes('update api_keys')),
    false,
    'the refused widening never reached storage',
  )
})

test('a key-manager holding the scope may widen, and narrowing needs no ceiling', async () => {
  reset()
  state.actorPermissions = ['ar.read', 'payroll.read', 'api.keys.manage']
  state.keyRow = ownedKeyRow(['ar.read'])
  state.ownerRoleRows = [{ permissions: ['ar.read', 'payroll.read'] }]

  const widened = await patchKey({ id: KEY_ID, scopes: ['ar.read', 'payroll.read'] })
  assert.equal(widened.status, 200)

  // Narrowing away a scope the editor does not hold stays available: only
  // ADDED scopes are ceiling-checked, untouched scopes are never re-checked.
  reset()
  state.actorPermissions = ['ar.read', 'api.keys.manage']
  state.keyRow = ownedKeyRow(['ar.read', 'payroll.read'])

  const narrowed = await patchKey({ id: KEY_ID, scopes: ['ar.read'] })
  assert.equal(narrowed.status, 200)
  assert.deepEqual(await narrowed.json(), { ok: true })
})

test('metadata edits, suspension, and revocation stay available to a limited key-manager', async () => {
  reset()
  state.actorPermissions = ['api.keys.manage']
  state.keyRow = ownedKeyRow(['payroll.read'])

  const renamed = await patchKey({ id: KEY_ID, name: 'renamed by manager' })
  assert.equal(renamed.status, 200)

  reset()
  state.actorPermissions = ['api.keys.manage']
  state.keyRow = ownedKeyRow(['payroll.read'])

  const suspended = await patchKey({ id: KEY_ID, isActive: false })
  assert.equal(suspended.status, 200)
  assert.ok(state.committed.some((t) => t.includes('update api_keys')))

  reset()
  state.actorPermissions = ['api.keys.manage']
  state.keyRow = { id: KEY_ID, name: 'doomed', key_prefix: 'ob_live_deadbee', is_active: true }

  const revoked = await revokeKey(KEY_ID)
  assert.equal(revoked.status, 200)
})

test('a cross-org key id is unknown, never a refusal or a write', async () => {
  reset()
  state.keyRow = null

  const response = await patchKey({ id: KEY_ID, scopes: ['ar.read'] })

  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'key not found' })
  assert.deepEqual(committedWrites(), [], 'an unknown key wrote nothing')
})

test('a super administrator is exempt from the grant ceiling', async () => {
  reset()
  state.actorSuperAdmin = true
  state.actorPermissions = []

  const created = await post({ name: 'platform key', scopes: ['payroll.read'] })
  assert.equal(created.status, 201)

  reset()
  state.actorSuperAdmin = true
  state.actorPermissions = []
  state.keyRow = ownedKeyRow(['ar.read'])

  const widened = await patchKey({ id: KEY_ID, scopes: ['ar.read', 'payroll.read'] })
  assert.equal(widened.status, 200)
})

test('resuming a suspended key refuses authority the editor does not hold', async () => {
  reset()
  state.actorPermissions = ['ar.read', 'api.keys.manage']
  state.keyRow = ownedKeyRow(['ar.read', 'payroll.read'], false)
  // The owner currently holds both scopes, so resuming would re-enable
  // payroll.read — above the editor's ceiling.
  state.ownerRoleRows = [{ permissions: ['ar.read', 'payroll.read'] }]

  const response = await patchKey({ id: KEY_ID, isActive: true })

  assert.equal(response.status, 403)
  const payload = (await response.json()) as { error: string; missing: string[] }
  assert.match(payload.error, /cannot grant permissions you do not hold: payroll\.read/)
  assert.deepEqual(payload.missing, ['payroll.read'])
  assert.deepEqual(committedWrites(), [], 'the refused resume wrote nothing')
  assert.equal((state.keyRow as { is_active: boolean }).is_active, false)
})

test('resuming a key whose extra scopes are inert to the owner is permitted', async () => {
  reset()
  state.actorPermissions = ['ar.read', 'api.keys.manage']
  state.keyRow = ownedKeyRow(['ar.read', 'payroll.read'], false)
  // The owner holds only ar.read today, so the resume re-enables exactly
  // ar.read — inside the editor's ceiling. payroll.read stays inert.
  state.ownerRoleRows = [{ permissions: ['ar.read'] }]

  const response = await patchKey({ id: KEY_ID, isActive: true })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
})

test('resuming an already-active key grants nothing and needs no ceiling', async () => {
  reset()
  state.actorPermissions = ['api.keys.manage']
  state.keyRow = ownedKeyRow(['payroll.read'], true)
  state.ownerRoleRows = [{ permissions: ['payroll.read'] }]

  const response = await patchKey({ id: KEY_ID, isActive: true })

  assert.equal(response.status, 200)
})

test('a subsidiary-scoped editor cannot widen an unrestricted owner’s key even for a held permission', async () => {
  reset()
  // The editor HOLDS payroll.read — the permission ceiling passes — but sees
  // only SUB_A while the owner is unrestricted: the same permission across
  // all entities is a wider grant than the editor may confer.
  state.actorPermissions = ['payroll.read', 'api.keys.manage']
  state.actorLens = [SUB_A]
  state.keyRow = ownedKeyRow(['ar.read'])
  state.ownerRoleRows = [{ permissions: ['ar.read', 'payroll.read'] }]
  state.ownerRestrictions = [{ restriction: { mode: 'all' } }]

  const response = await patchKey({ id: KEY_ID, scopes: ['ar.read', 'payroll.read'] })

  assert.equal(response.status, 403)
  // The owner sees everything, so the remedy names unrestricted visibility.
  assert.match((await response.json()).error, /unrestricted subsidiary visibility/)
  assert.deepEqual(committedWrites(), [], 'the refused widening wrote nothing')
  assert.deepEqual((state.keyRow as { scopes: string[] }).scopes, ['ar.read'])
})

test('a subsidiary-scoped editor may widen an owner within the same entity lens', async () => {
  reset()
  state.actorPermissions = ['payroll.read', 'api.keys.manage']
  state.actorLens = [SUB_A]
  state.keyRow = ownedKeyRow(['ar.read'])
  state.ownerRoleRows = [{ permissions: ['ar.read', 'payroll.read'] }]
  state.ownerRestrictions = [{ restriction: { mode: 'list', subsidiaryIds: [SUB_A] } }]

  const response = await patchKey({ id: KEY_ID, scopes: ['ar.read', 'payroll.read'] })

  assert.equal(response.status, 200)

  // A strictly wider owner lens is still refused for the held permission.
  reset()
  state.actorPermissions = ['payroll.read', 'api.keys.manage']
  state.actorLens = [SUB_A]
  state.keyRow = ownedKeyRow(['ar.read'])
  state.ownerRoleRows = [{ permissions: ['ar.read', 'payroll.read'] }]
  state.ownerRestrictions = [{ restriction: { mode: 'list', subsidiaryIds: [SUB_A, SUB_B] } }]

  const wider = await patchKey({ id: KEY_ID, scopes: ['ar.read', 'payroll.read'] })
  assert.equal(wider.status, 403)
  // A finite owner gap names covering visibility, never unrestricted scope.
  assert.match((await wider.json()).error, /covers the key owner's subsidiaries/)
  assert.deepEqual(committedWrites(), [], 'the refused widening wrote nothing')
})

test('widening a deactivated owner’s key is refused until the owner is reactivated', async () => {
  reset()
  state.actorPermissions = ['ar.read', 'payroll.read', 'api.keys.manage']
  state.keyRow = ownedKeyRow(['ar.read'])
  state.ownerIdentity = { isSuperAdmin: false, isActive: false }
  state.ownerRoleRows = [{ permissions: ['ar.read', 'payroll.read'] }]
  // The stored entity policy is 'all', but the trusted lens resolves EMPTY
  // for inactive users — the grant must wait, not pass against thin air.
  state.ownerRestrictions = [{ restriction: { mode: 'all' } }]

  const response = await patchKey({ id: KEY_ID, scopes: ['ar.read', 'payroll.read'] })

  assert.equal(response.status, 409)
  assert.match((await response.json()).error, /reactivate the owner before widening/)
  assert.deepEqual(committedWrites(), [], 'the refused widening wrote nothing')
  assert.deepEqual((state.keyRow as { scopes: string[] }).scopes, ['ar.read'])
})

test('resuming a deactivated owner’s key re-enables nothing and stays permitted', async () => {
  reset()
  state.actorPermissions = ['ar.read', 'api.keys.manage']
  state.keyRow = ownedKeyRow(['ar.read', 'payroll.read'], false)
  state.ownerIdentity = { isSuperAdmin: false, isActive: false }
  state.ownerRoleRows = [{ permissions: ['ar.read', 'payroll.read'] }]

  const response = await patchKey({ id: KEY_ID, isActive: true })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
})

test('an empty editor lens grants no entity scope, an unrestricted one grants any', async () => {
  // Empty lens: the editor sees nothing, so even a same-lens owner is wider.
  reset()
  state.actorPermissions = ['payroll.read', 'api.keys.manage']
  state.actorLens = []
  state.keyRow = ownedKeyRow(['ar.read'])
  state.ownerRoleRows = [{ permissions: ['ar.read', 'payroll.read'] }]
  state.ownerRestrictions = [{ restriction: { mode: 'list', subsidiaryIds: [SUB_A] } }]

  const refused = await patchKey({ id: KEY_ID, scopes: ['ar.read', 'payroll.read'] })
  assert.equal(refused.status, 403)
  assert.deepEqual(committedWrites(), [], 'the refused widening wrote nothing')

  // Null (unrestricted) lens on both sides: the entity ceiling passes and the
  // held permission grants.
  reset()
  state.actorPermissions = ['payroll.read', 'api.keys.manage']
  state.actorLens = null
  state.keyRow = ownedKeyRow(['ar.read'])
  state.ownerRoleRows = [{ permissions: ['ar.read', 'payroll.read'] }]
  state.ownerRestrictions = [{ restriction: { mode: 'all' } }]

  const allowed = await patchKey({ id: KEY_ID, scopes: ['ar.read', 'payroll.read'] })
  assert.equal(allowed.status, 200)
})

test('create rejects falsy non-null expiresAt impostors instead of minting a non-expiring key', async () => {
  for (const expiresAt of [0, false, '', 1234567890, true, {}]) {
    reset()

    const response = await post({ name: 'expiry-confused key', scopes: ['gl.read'], expiresAt })

    assert.equal(response.status, 400, `expiresAt=${JSON.stringify(expiresAt)} must be refused`)
    assert.match((await response.json()).error, /expiresAt must be an ISO date string or null/)
    assert.deepEqual(committedWrites(), [], 'a type-confused expiry never reaches storage')
  }
})

test('create accepts an explicit null expiry and a future date, and refuses past or malformed dates', async () => {
  reset()
  const explicitNull = await post({ name: 'non-expiring key', scopes: ['gl.read'], expiresAt: null })
  assert.equal(explicitNull.status, 201)

  reset()
  const future = await post({
    name: 'expiring key',
    scopes: ['gl.read'],
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  })
  assert.equal(future.status, 201)

  for (const expiresAt of ['not-a-date', new Date(Date.now() - 1000).toISOString()]) {
    reset()
    const response = await post({ name: 'bad expiry key', scopes: ['gl.read'], expiresAt })
    assert.equal(response.status, 400, `expiresAt=${expiresAt} must be refused`)
    assert.deepEqual(committedWrites(), [], 'a bad expiry never reaches storage')
  }
})

test('revocation keeps the stored fingerprint stable while destroying the credential', async () => {
  reset()
  state.keyRow = { id: KEY_ID, name: 'leaked key', key_prefix: 'ob_live_deadbee', is_active: true }

  const response = await revokeKey(KEY_ID)

  assert.equal(response.status, 200)
  const update = state.committed.find((t) => t.includes('update api_keys'))
  assert.ok(update, 'the revocation update committed')
  assert.match(update!, /key_hash/, 'the original hash is replaced — the old secret can never resolve again')
  assert.equal(
    update!.includes('key_prefix'),
    false,
    'the stored prefix is kept — the masked display stays stable across revoke (F-t01-011)',
  )
  assert.equal(
    update!.includes('key_preview'),
    false,
    'the stored preview is kept — the masked display stays stable across revoke (F-t01-011)',
  )
  const audit = state.committed.find((t) => t.includes('insert into audit_log'))
  assert.ok(audit, 'the revocation evidence committed in the same unit')
  assert.equal(
    audit!.includes('[destroyed]'),
    false,
    'the audit keeps the original fingerprint, not a destroyed marker',
  )
})
