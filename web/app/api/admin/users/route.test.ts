import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Route boundary regression for admin user mutations. Role assignment and
// account activation changes are privileged state transitions: their audit
// evidence must commit in the same tenant transaction, so an audit failure
// cannot leave an unaudited role or account state behind.
const stateKey = Symbol.for('openbooks.admin-users-route-test')
interface RouteState {
  executed: string[]
  committed: string[]
  pending: string[]
  inTx: boolean
  transactionCalls: number
  failOnText?: string
  assignments: { id: string; role_id: string }[]
  /** Permissions carried by the role being assigned (what `app_roles.permissions` returns). */
  rolePermissions: string[]
  /** Restriction carried by the role being assigned (what `app_roles.subsidiary_restriction` returns). */
  roleRestriction: unknown
  /** Target account flag returned by the user-row lock in set-active. */
  targetActive: boolean
  /** Role ids returned for the target's assignments in set-active activation. */
  assignmentRoleIds: string[]
  /** Stored role policies returned for activation/resend grant checks. */
  grantPolicies: { id: string; permissions: string[]; restriction: unknown }[]
  /** Actor's own stored role restrictions returned for coverage checks. */
  actorRestrictions: { restriction: unknown }[]
  /** Subsidiary tree returned for scope resolution. */
  subsidiaries: { id: string; parentId: string | null }[]
  /** Stored permission overrides returned for activation grant checks. */
  overrides: { permission: string; effect: 'grant' | 'deny' }[]
  /** The acting administrator's resolved authorization, as guardPermission would return it. */
  authz: { user: { orgId: string; id: string; isSuperAdmin: boolean }; permissions: Set<string>; allowedSubsidiaryIds?: Set<string> | null }
}

const ORG_ID = '00000000-0000-4000-8000-00000000a001'
const ACTOR_ID = '00000000-0000-4000-8000-00000000a002'
/** Everything a user administrator ordinarily holds; deliberately NOT the full catalogue. */
const ACTOR_PERMISSIONS = ['admin.users.manage', 'gl.read', 'ap.read', 'ar.read']
const SUB_A = '00000000-0000-4000-8000-00000000b00a'
const SUB_B = '00000000-0000-4000-8000-00000000b00b'
function actorAuthz(overrides: { permissions?: string[]; isSuperAdmin?: boolean; allowedSubsidiaryIds?: Set<string> | null } = {}) {
  return {
    user: { orgId: ORG_ID, id: ACTOR_ID, isSuperAdmin: overrides.isSuperAdmin ?? false },
    permissions: new Set(overrides.permissions ?? ACTOR_PERMISSIONS),
    allowedSubsidiaryIds: overrides.allowedSubsidiaryIds,
  }
}

const state: RouteState = {
  executed: [],
  committed: [],
  pending: [],
  inTx: false,
  transactionCalls: 0,
  assignments: [
    {
      id: '00000000-0000-4000-8000-00000000a004',
      role_id: '00000000-0000-4000-8000-00000000a003',
    },
    {
      id: '00000000-0000-4000-8000-00000000a005',
      role_id: '00000000-0000-4000-8000-00000000a006',
    },
  ],
  rolePermissions: ['gl.read'],
  roleRestriction: { mode: 'all' },
  targetActive: true,
  assignmentRoleIds: [],
  grantPolicies: [],
  actorRestrictions: [{ restriction: { mode: 'all' } }],
  subsidiaries: [],
  overrides: [],
  authz: actorAuthz(),
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

/** Flatten a drizzle SQL chunk into its raw text for routing scripted replies. */
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
;(globalThis as typeof globalThis & { openbooksSqlTextAdminUsers: typeof sqlText }).openbooksSqlTextAdminUsers = sqlText

const TARGET_ID = '00000000-0000-4000-8000-00000000a003'
const ROLE_ID = '00000000-0000-4000-8000-00000000a006'
const ASSIGNMENT_ID = '00000000-0000-4000-8000-00000000a007'

const mockSources = new Map<string, string>([
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.admin-users-route-test')]
      const sqlText = globalThis.openbooksSqlTextAdminUsers
      const isWrite = (text) =>
        text.includes('insert into role_assignments') ||
        text.includes('delete from role_assignments') ||
        text.includes('update users') ||
        text.includes('update auth_sessions') ||
        text.includes('insert into audit_log')
      const rowsFor = (text) => {
        if (text.includes('select id, is_active from users')) return [{ id: '${TARGET_ID}', is_active: state.targetActive }]
        if (text.includes('select id from users')) return [{ id: '${TARGET_ID}' }]
        if (text.includes('select id, key, permissions, subsidiary_restriction from app_roles')) {
          return [{ id: '${ROLE_ID}', key: 'member', permissions: state.rolePermissions, subsidiary_restriction: state.roleRestriction }]
        }
        if (text.includes('subsidiary_restriction as restriction') && text.includes('from role_assignments')) {
          return state.actorRestrictions
        }
        if (text.includes('subsidiary_restriction as restriction') && text.includes('from app_roles')) return state.grantPolicies
        if (text.includes('from subsidiaries')) return state.subsidiaries
        if (text.includes('from user_permission_overrides')) return state.overrides
        if (text.includes('insert into role_assignments')) return [{ id: '${ASSIGNMENT_ID}' }]
        if (text.includes('select id, role_id from role_assignments')) return state.assignments
        if (text.includes('select role_id') && text.includes('from role_assignments')) {
          return state.assignmentRoleIds.map((role_id) => ({ role_id }))
        }
        if (text.includes('delete from role_assignments')) return [{ id: '${ASSIGNMENT_ID}' }]
        if (text.includes('select 1') && text.includes('from role_assignments')) return [{ '?column?': 1 }]
        if (text.includes('with changed_identity')) return [{ id: '${TARGET_ID}' }]
        return []
      }
      export const db = {
        async execute(query) {
          const text = sqlText(query)
          state.executed.push(text)
          if (state.failOnText && text.includes(state.failOnText)) {
            throw new Error('forced storage failure: ' + state.failOnText)
          }
          if (isWrite(text)) {
            const ledger = state.inTx ? state.pending : state.committed
            ledger.push(text)
          }
          return { rows: rowsFor(text) }
        },
        transaction: async (work) => work({}),
      }
      export async function withTransactionSavepoint(_runner, work) {
        const start = state.pending.length
        try { return await work() }
        catch (error) { state.pending.splice(start); throw error }
      }
      export async function withOrgTransaction(_orgId, work) {
        state.transactionCalls++
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
      export function currentRequestOrgResolver() { return null }
    `,
  ],
  [
    'mock:json',
    `
      export const jsonObject = {}
      export async function parseJsonBody(request) {
        return { ok: true, data: await request.json() }
      }
    `,
  ],
  [
    'mock:authz',
    `
      const state = globalThis[Symbol.for('openbooks.admin-users-route-test')]
      export async function guardPermission() {
        return state.authz.allowedSubsidiaryIds === undefined
          ? { ...state.authz, allowedSubsidiaryIds: null }
          : state.authz
      }
      // Direct-record visibility over one loaded party: the canonical
      // subsidiary-scope rule (null scope passes; null subsidiary is
      // org-wide only when the caller passes orgWideNull).
      export function subsidiaryScopeAllows(scope, subsidiaryId, opts) {
        if (scope === null || scope === undefined) return true
        if (subsidiaryId === null || subsidiaryId === undefined || subsidiaryId === '') {
          return (opts && opts.orgWideNull) === true
        }
        return scope.has(subsidiaryId)
      }
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['@openbooks/engine/src/platform/db.ts', 'mock:db'],
  ['@/lib/api/json', 'mock:json'],
  ['../../../../lib/authz', 'mock:authz'],
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
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?admin-users-route-test'
const { POST } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function reset(): void {
  state.executed = []
  state.committed = []
  state.pending = []
  state.inTx = false
  state.transactionCalls = 0
  state.failOnText = undefined
  state.rolePermissions = ['gl.read']
  state.roleRestriction = { mode: 'all' }
  state.targetActive = true
  state.assignmentRoleIds = []
  state.grantPolicies = []
  state.actorRestrictions = [{ restriction: { mode: 'all' } }]
  state.subsidiaries = []
  state.overrides = []
  state.authz = actorAuthz()
  state.assignments = [
    {
      id: '00000000-0000-4000-8000-00000000a004',
      role_id: '00000000-0000-4000-8000-00000000a003',
    },
    {
      id: '00000000-0000-4000-8000-00000000a005',
      role_id: '00000000-0000-4000-8000-00000000a006',
    },
  ]
}

function post(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request('http://openbooks.test/api/admin/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

test('assign commits the role assignment and its audit evidence together', async () => {
  reset()

  const response = await post({ action: 'assign', userId: TARGET_ID, roleId: ROLE_ID })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  const mutationIndex = state.committed.findIndex((text) => text.includes('insert into role_assignments'))
  const auditIndex = state.committed.findIndex((text) => text.includes('insert into audit_log'))
  assert.ok(mutationIndex >= 0, 'the role assignment committed')
  assert.ok(auditIndex > mutationIndex, 'the assignment audit committed after it in the same unit')
  assert.equal(state.transactionCalls, 1, 'the assignment used the tenant transaction primitive')
})

test('a failed assignment audit rolls back the role assignment', async () => {
  reset()
  state.failOnText = 'insert into audit_log'

  await assert.rejects(
    () => post({ action: 'assign', userId: TARGET_ID, roleId: ROLE_ID }),
    /forced storage failure/,
  )

  assert.ok(
    state.executed.some((text) => text.includes('insert into role_assignments')),
    'the assignment was attempted inside the transaction',
  )
  assert.equal(
    state.committed.some((text) => text.includes('insert into role_assignments')),
    false,
    'the role assignment did not commit without its audit evidence',
  )
  assert.equal(
    state.committed.some((text) => text.includes('insert into audit_log')),
    false,
    'the failed audit did not partially commit',
  )
})

test('set-active commits account and session revocation with audit evidence together', async () => {
  reset()

  const response = await post({ action: 'set-active', userId: TARGET_ID, isActive: false })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  const mutation = state.committed.find((text) => text.includes('with changed_identity'))
  assert.ok(mutation, 'the account state mutation committed')
  assert.match(mutation, /update users/, 'the account was deactivated')
  assert.match(mutation, /update auth_sessions/, 'sessions were revoked in the same statement')
  assert.ok(
    state.committed.some((text) => text.includes('insert into audit_log')),
    'the account mutation audit committed in the same unit',
  )
  assert.equal(state.transactionCalls, 1, 'the activation mutation used the tenant transaction primitive')
})

test('a failed set-active audit rolls back account and session changes', async () => {
  reset()
  state.failOnText = 'insert into audit_log'

  await assert.rejects(
    () => post({ action: 'set-active', userId: TARGET_ID, isActive: false }),
    /forced storage failure/,
  )

  assert.ok(
    state.executed.some((text) => text.includes('with changed_identity')),
    'the account and session mutation was attempted inside the transaction',
  )
  assert.equal(
    state.committed.some((text) => text.includes('with changed_identity')),
    false,
    'the account and session changes did not commit without audit evidence',
  )
  assert.equal(
    state.committed.some((text) => text.includes('insert into audit_log')),
    false,
    'the failed audit did not partially commit',
  )
})

// ID2 — privilege ceiling. admin.users.manage is an ordinary permission; the
// role being granted must sit inside the actor's own effective permissions and
// an administrator may never grant a role to themselves (super admins exempt).

test('an administrator cannot assign a role carrying permissions they do not hold', async () => {
  reset()
  state.rolePermissions = ['gl.read', 'gl.post', 'admin.roles.manage']

  const response = await post({ action: 'assign', userId: TARGET_ID, roleId: ROLE_ID })

  assert.equal(response.status, 403)
  const body = (await response.json()) as { error: string; missing?: string[] }
  assert.match(body.error, /gl\.post/)
  assert.match(body.error, /admin\.roles\.manage/)
  assert.deepEqual(body.missing, ['gl.post', 'admin.roles.manage'])
  assert.equal(
    state.executed.some((text) => text.includes('insert into role_assignments')),
    false,
    'no assignment was attempted',
  )
})

test('a role within the ceiling is assignable and honours module wildcards', async () => {
  reset()
  state.authz = actorAuthz({ permissions: ['admin.users.manage', 'gl.*'] })
  state.rolePermissions = ['gl.read', 'gl.post']

  const response = await post({ action: 'assign', userId: TARGET_ID, roleId: ROLE_ID })

  assert.equal(response.status, 200)
  assert.ok(state.committed.some((text) => text.includes('insert into role_assignments')))
})

test('an administrator cannot grant a role to themselves', async () => {
  reset()
  state.rolePermissions = ['gl.read']

  const response = await post({ action: 'assign', userId: ACTOR_ID, roleId: ROLE_ID })

  assert.equal(response.status, 403)
  assert.match(((await response.json()) as { error: string }).error, /yourself|own account/i)
  assert.equal(
    state.executed.some((text) => text.includes('insert into role_assignments')),
    false,
    'no self-grant was attempted',
  )
})

test('a super administrator is exempt from the ceiling and the self-grant rule', async () => {
  reset()
  state.authz = actorAuthz({ permissions: ['*'], isSuperAdmin: true })
  state.rolePermissions = ['admin.roles.manage', 'gl.post']

  const response = await post({ action: 'assign', userId: ACTOR_ID, roleId: ROLE_ID })

  assert.equal(response.status, 200)
  assert.ok(state.committed.some((text) => text.includes('insert into role_assignments')))
})

// Delegation ceiling: the granted role's resolved subsidiary scope must sit
// inside the actor's trusted lens, or the union of the target's roles would
// widen past what the actor may delegate.

function scopedActor(): void {
  state.authz = actorAuthz({ allowedSubsidiaryIds: new Set([SUB_A]) })
  state.actorRestrictions = [{ restriction: { mode: 'list', subsidiaryIds: [SUB_A] } }]
  state.subsidiaries = [
    { id: SUB_A, parentId: null },
    { id: SUB_B, parentId: SUB_A },
  ]
}

test('a scoped administrator cannot assign an unrestricted role', async () => {
  reset()
  scopedActor()
  state.rolePermissions = []
  state.roleRestriction = { mode: 'all' }

  const response = await post({ action: 'assign', userId: TARGET_ID, roleId: ROLE_ID })

  assert.equal(response.status, 403)
  const refusal = ((await response.json()) as { error: string }).error
  assert.match(refusal, /beyond your scope/)
  assert.match(refusal, /administrator whose scope/)
  assert.equal(
    state.executed.some((text) => text.includes('insert into role_assignments')),
    false,
    'no assignment was attempted',
  )
})

test('a scoped administrator can assign a role inside their own lens', async () => {
  reset()
  scopedActor()
  state.rolePermissions = ['gl.read']
  state.roleRestriction = { mode: 'list', subsidiaryIds: [SUB_A] }

  const response = await post({ action: 'assign', userId: TARGET_ID, roleId: ROLE_ID })

  assert.equal(response.status, 200)
  assert.ok(state.committed.some((text) => text.includes('insert into role_assignments')))
})

test('a finite-list administrator cannot assign an open subtree matching today', async () => {
  // SUB_B is a leaf: subtree(SUB_B) enumerates exactly to the actor's list,
  // but the grant covers SUB_B's future children, so it refuses.
  reset()
  scopedActor()
  state.actorRestrictions = [{ restriction: { mode: 'list', subsidiaryIds: [SUB_B] } }]
  state.authz = actorAuthz({ allowedSubsidiaryIds: new Set([SUB_B]) })
  state.rolePermissions = []
  state.roleRestriction = { mode: 'subtree', subsidiaryId: SUB_B }

  const response = await post({ action: 'assign', userId: TARGET_ID, roleId: ROLE_ID })

  assert.equal(response.status, 403)
  assert.match(((await response.json()) as { error: string }).error, /beyond your scope/)
  assert.equal(
    state.executed.some((text) => text.includes('insert into role_assignments')),
    false,
    'no assignment was attempted',
  )

  state.roleRestriction = { mode: 'list', subsidiaryIds: [SUB_B] }
  const control = await post({ action: 'assign', userId: TARGET_ID, roleId: ROLE_ID })
  assert.equal(control.status, 200)
})

test('a subtree administrator delegates inside its own subtree', async () => {
  reset()
  scopedActor()
  state.actorRestrictions = [{ restriction: { mode: 'subtree', subsidiaryId: SUB_A } }]
  state.rolePermissions = ['gl.read']
  state.roleRestriction = { mode: 'subtree', subsidiaryId: SUB_B }

  const response = await post({ action: 'assign', userId: TARGET_ID, roleId: ROLE_ID })

  assert.equal(response.status, 200)
  assert.ok(state.committed.some((text) => text.includes('insert into role_assignments')))
})

test('deactivation needs no scope authority over the removed access', async () => {
  reset()
  scopedActor()
  state.targetActive = true

  const response = await post({ action: 'set-active', userId: TARGET_ID, isActive: false })

  assert.equal(response.status, 200)
})

test('reactivation refuses a stored union wider than the actor lens', async () => {
  reset()
  scopedActor()
  state.targetActive = false
  state.assignmentRoleIds = [ROLE_ID]
  state.grantPolicies = [{ id: ROLE_ID, permissions: ['gl.read'], restriction: { mode: 'all' } }]

  const response = await post({ action: 'set-active', userId: TARGET_ID, isActive: true })

  assert.equal(response.status, 403)
  assert.match(((await response.json()) as { error: string }).error, /beyond your scope/)
  assert.equal(
    state.executed.some((text) => text.includes('with changed_identity')),
    false,
    'no activation was attempted',
  )
})

test('reactivation inside the lens commits with audit evidence', async () => {
  reset()
  scopedActor()
  state.targetActive = false
  state.assignmentRoleIds = [ROLE_ID]
  state.grantPolicies = [{ id: ROLE_ID, permissions: ['gl.read'], restriction: { mode: 'list', subsidiaryIds: [SUB_A] } }]

  const response = await post({ action: 'set-active', userId: TARGET_ID, isActive: true })

  assert.equal(response.status, 200)
  assert.ok(state.committed.some((text) => text.includes('with changed_identity')))
  assert.ok(state.committed.some((text) => text.includes('insert into audit_log')))
})

test('reactivation refuses a grant override above the actor ceiling', async () => {
  reset()
  scopedActor()
  state.targetActive = false
  state.assignmentRoleIds = [ROLE_ID]
  state.grantPolicies = [{ id: ROLE_ID, permissions: [], restriction: { mode: 'list', subsidiaryIds: [SUB_A] } }]
  state.overrides = [{ permission: 'gl.post', effect: 'grant' }]

  const response = await post({ action: 'set-active', userId: TARGET_ID, isActive: true })

  assert.equal(response.status, 403)
  assert.match(((await response.json()) as { error: string }).error, /reactivate permissions you do not hold/)
})

test('reactivation does not treat a deny override as a grant', async () => {
  reset()
  scopedActor()
  state.targetActive = false
  state.assignmentRoleIds = [ROLE_ID]
  state.grantPolicies = [{ id: ROLE_ID, permissions: ['gl.read'], restriction: { mode: 'list', subsidiaryIds: [SUB_A] } }]
  state.overrides = [{ permission: 'gl.post', effect: 'deny' }]

  const response = await post({ action: 'set-active', userId: TARGET_ID, isActive: true })

  assert.equal(response.status, 200)
})
