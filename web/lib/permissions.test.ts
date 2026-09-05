import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import {
  INVENTORY_ACTION_PERMISSIONS,
  INVENTORY_ADVANCED_ACTION_PERMISSIONS,
} from '@openbooks/engine/src/permissions.ts'
import {
  BUILT_IN_ROLES,
  PERMISSION_CATALOGUE,
  permissionSetCovers,
  resolveEffectivePermissions,
} from './permissions.ts'
import { NextResponse } from 'next/server'

test('a user without an explicit role assignment receives no role permissions', () => {
  const permissions = resolveEffectivePermissions({
    rolePermissionSets: [],
    overrides: [],
  })
  assert.deepEqual([...permissions], [])
})

test('explicit role assignments are unioned and deny overrides win', () => {
  const permissions = resolveEffectivePermissions({
    rolePermissionSets: [['ap.read', 'ap.create'], ['reports.read']],
    overrides: [
      { permission: 'ap.create', effect: 'deny' },
      { permission: 'banking.read', effect: 'grant' },
    ],
  })
  assert.deepEqual([...permissions].sort(), ['ap.read', 'banking.read', 'reports.read'])
})

test('specific denies override a full wildcard grant while preserving other permissions', () => {
  const permissions = resolveEffectivePermissions({
    rolePermissionSets: [['*']],
    overrides: [{ permission: 'gl.post', effect: 'deny' }],
  })
  assert.equal(permissionSetCovers(permissions, 'gl.post'), false)
  assert.equal(permissionSetCovers(permissions, 'gl.read'), true)
})

/**
 * Representative SoD controls for inventory money movement
 * (fnd_mt9g743u_w8y6mv). The routes gate each verb through
 * INVENTORY_ACTION_PERMISSIONS / INVENTORY_ADVANCED_ACTION_PERMISSIONS, so the
 * mapping plus wildcard semantics ARE the boundary; the deep route, subsidiary
 * fencing, cross-entity denial, reversal atomicity, and audit-failure proofs
 * live in web/lib/permission-registry.test.ts and are equivalent coverage.
 */

test('a catalog maintainer holding items.manage alone is refused every financial inventory action', () => {
  // The route consults these exact mappings, so asserting them asserts the
  // production write path, and every demanded key must be role-assignable.
  const demanded = [
    ...Object.values(INVENTORY_ACTION_PERMISSIONS),
    ...Object.values(INVENTORY_ADVANCED_ACTION_PERMISSIONS),
  ]
  for (const perm of demanded) {
    assert.ok(
      (PERMISSION_CATALOGUE as readonly string[]).includes(perm),
      `${perm} must be seeded so someone can hold it`,
    )
    assert.equal(
      permissionSetCovers(new Set(['items.manage']), perm),
      false,
      `items.manage must not carry ${perm}: catalog maintenance is not ledger authority`,
    )
  }
  // Reversal is deliberately distinct from posting (maker/checker).
  assert.equal(INVENTORY_ACTION_PERMISSIONS.reverse, 'items.reverse')
  for (const [action, perm] of Object.entries(INVENTORY_ACTION_PERMISSIONS)) {
    if (action !== 'reverse') {
      assert.equal(perm, 'items.post', `${action} moves value and demands posting authority`)
    }
  }
})

test('principals with the right financial authority are still allowed through', () => {
  // A poster clears every forward verb; wildcard grants keep working.
  const poster = new Set(['gl.post', 'items.post'])
  for (const [action, perm] of Object.entries(INVENTORY_ACTION_PERMISSIONS)) {
    if (action === 'reverse') continue
    assert.equal(permissionSetCovers(poster, perm), true, `${action} allowed for items.post`)
  }
  assert.equal(permissionSetCovers(new Set(['items.*']), 'items.reverse'), true)
  // Built-ins split the duties: controller unwinds, accountant only posts,
  // and no read-only/approval/sales role touches value at all.
  const holds = (role: string, perm: string) =>
    permissionSetCovers(new Set(BUILT_IN_ROLES[role]!.permissions), perm)
  assert.equal(holds('controller', 'items.post'), true)
  assert.equal(holds('controller', 'items.reverse'), true)
  assert.equal(holds('accountant', 'items.post'), true)
  assert.equal(holds('accountant', 'items.reverse'), false)
  for (const role of ['approver', 'viewer', 'sales_manager', 'sales_rep']) {
    assert.equal(holds(role, 'items.post'), false, `${role} must not post`)
    assert.equal(holds(role, 'items.reverse'), false, `${role} must not reverse`)
  }
})

/**
 * Organization-wide outbound email transport authority (fnd_mt989v18_3b1g7c).
 * The email config/test surfaces used to gate on admin.users.manage, so a
 * people-administrator could redirect or suppress every org email (invoices,
 * dunning, password resets) and replace the transport's sealed credential.
 * They now sit behind admin.setup.manage like every other org-wide
 * configuration surface. These cases drive the REAL route handlers through
 * the same module-hooks seam as web/lib/setup-route-contract.test.ts, with
 * the shared engine service and provider transport instrumented so a denial
 * provably causes zero side effects.
 */

interface EmailRouteState {
  permissions: Set<string>
  engineCalls: Array<Record<string, unknown>>
  sendCalls: Array<Record<string, unknown>>
  /** Handed to the authz mock through the state bag: mock modules must stay import-free. */
  NextResponse: typeof NextResponse
}

const stateKey = Symbol.for('openbooks.email-route-permission-test')
const emailState: EmailRouteState = {
  permissions: new Set(),
  engineCalls: [],
  sendCalls: [],
  NextResponse,
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = emailState

let realEmailsUrl = ''
const mockedSpecifiers = new Map<string, string>([
  ['@/lib/api/json', 'mock:json'],
  ['../../../../lib/authz', 'mock:authz'],
  ['../../../../../lib/authz', 'mock:authz'],
  ['@openbooks/engine/src/email-config.ts', 'mock:email-config'],
])

const mockSources = new Map<string, string>([
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
      const state = globalThis[Symbol.for('openbooks.email-route-permission-test')]
      export async function guardPermission(permission) {
        // A real NextResponse, not a bare Response: the routes branch on
        // \`gate instanceof NextResponse\` to tell denial from success. The
        // class comes in via the state bag — mock modules stay import-free
        // because a mock: URL has no package scope to resolve from.
        if (!state.permissions.has(permission)) {
          return new state.NextResponse(JSON.stringify({ error: \`missing permission: \${permission}\` }), {
            status: 403,
            headers: { 'content-type': 'application/json' },
          })
        }
        return {
          user: { orgId: 'org-1', id: 'user-1' },
          permissions: state.permissions,
          allowedSubsidiaryIds: null,
        }
      }
    `,
  ],
  [
    'mock:email-config',
    `
      const state = globalThis[Symbol.for('openbooks.email-route-permission-test')]
      const view = { enabled: false, provider: 'smtp', fromEmail: 'noreply@example.com', hasSecret: false }
      export async function readOrgEmailConfigView(orgId) {
        state.engineCalls.push({ fn: 'readOrgEmailConfigView', orgId })
        return view
      }
      export async function saveOrgEmailConfig(orgId, input) {
        state.engineCalls.push({ fn: 'saveOrgEmailConfig', orgId, input })
      }
      export async function resolveOrgEmailTransport(orgId) {
        state.engineCalls.push({ fn: 'resolveOrgEmailTransport', orgId })
        return { provider: 'smtp', from: 'noreply@example.com', replyTo: null }
      }
      export async function insertEmailLog(row) {
        state.engineCalls.push({ fn: 'insertEmailLog', row })
        return 'log-1'
      }
      export async function markEmailSent(orgId, id, providerMessageId) {
        state.engineCalls.push({ fn: 'markEmailSent', orgId, id, providerMessageId })
      }
      export async function markEmailFailed(orgId, id, error) {
        state.engineCalls.push({ fn: 'markEmailFailed', orgId, id, error })
      }
      export async function markEmailUncertain(orgId, id, reason) {
        state.engineCalls.push({ fn: 'markEmailUncertain', orgId, id, reason })
      }
    `,
  ],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    // Keep every real emails export (validators included); only sendVia is
    // instrumented below so no test ever touches a real provider.
    if (specifier === '@openbooks/emails') {
      realEmailsUrl = nextResolve(specifier, context).url
      return { url: 'mock:emails', shortCircuit: true }
    }
    const mocked = mockedSpecifiers.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:emails') {
      const source = `export * from '${realEmailsUrl}'
const state = globalThis[Symbol.for('openbooks.email-route-permission-test')]
export async function sendVia(transport, input, identity) {
  state.sendCalls.push({ transport, input, identity })
  return { kind: 'sent', providerMessageId: 'msg-1' }
}
`
      return { format: 'module', source, shortCircuit: true }
    }
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const configRouteUrl = '../app/api/admin/email/route.ts?email-route-permission-test'
const testRouteUrl = '../app/api/admin/email/test/route.ts?email-route-permission-test'
const emailRoutesReady = Promise.all([
  import(configRouteUrl) as Promise<typeof import('../app/api/admin/email/route.ts')>,
  import(testRouteUrl) as Promise<typeof import('../app/api/admin/email/test/route.ts')>,
]).then(([configRoutes, testRoutes]) => {
  hooks.deregister()
  return { configRoutes, testRoutes }
})

function resetEmailAuthority(permissions: string[]): void {
  emailState.permissions = new Set(permissions)
  emailState.engineCalls.length = 0
  emailState.sendCalls.length = 0
}

async function putConfig(body: Record<string, unknown>): Promise<Response> {
  const { configRoutes } = await emailRoutesReady
  return configRoutes.PUT(
    new Request('http://localhost/api/admin/email', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

async function postTestSend(to: string): Promise<Response> {
  const { testRoutes } = await emailRoutesReady
  return testRoutes.POST(
    new Request('http://localhost/api/admin/email/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to }),
    }),
  )
}

test('a users-admin without setup authority cannot mutate the org email transport or send through it', async () => {
  resetEmailAuthority(['admin.users.manage'])

  const saved = await putConfig({
    enabled: true,
    provider: 'smtp',
    smtpHost: 'smtp.attacker.example',
    secret: 'replaced-secret',
  })
  assert.equal(saved.status, 403)

  const sent = await postTestSend('victim@example.com')
  assert.equal(sent.status, 403)

  // Denial is total: no config write/read, no email_log row, no provider send.
  assert.deepEqual(emailState.engineCalls, [])
  assert.deepEqual(emailState.sendCalls, [])
})

test('setup authority reaches every email handler without holding users-manage', async () => {
  resetEmailAuthority(['admin.setup.manage'])

  const { configRoutes } = await emailRoutesReady
  const read = await configRoutes.GET()
  assert.equal(read.status, 200)
  assert.deepEqual(await read.json(), {
    enabled: false,
    provider: 'smtp',
    fromEmail: 'noreply@example.com',
    hasSecret: false,
  })

  const saved = await putConfig({
    enabled: true,
    provider: 'smtp',
    smtpHost: 'smtp.example.com',
    secret: 's3cret',
  })
  assert.equal(saved.status, 200)
  // The exact normalized save input — secret still plaintext here; the shared
  // engine service seals it (unchanged by this slice).
  assert.deepEqual(emailState.engineCalls[1], {
    fn: 'saveOrgEmailConfig',
    orgId: 'org-1',
    input: {
      enabled: true,
      provider: 'smtp',
      fromName: undefined,
      fromEmail: undefined,
      replyTo: undefined,
      mailgunDomain: undefined,
      mailgunRegion: undefined,
      smtpHost: 'smtp.example.com',
      smtpPort: undefined,
      smtpSecure: false,
      smtpUsername: undefined,
      secret: 's3cret',
    },
  })

  const sent = await postTestSend('colleague@example.com')
  assert.equal(sent.status, 200)
  assert.deepEqual(await sent.json(), { ok: true, provider: 'smtp', messageId: 'msg-1' })
  assert.deepEqual(
    emailState.engineCalls.map((call) => call.fn),
    [
      'readOrgEmailConfigView', // GET
      'saveOrgEmailConfig', // PUT persist
      'readOrgEmailConfigView', // PUT response view
      'resolveOrgEmailTransport', // POST transport resolve
      'insertEmailLog', // POST email_log row
      'markEmailSent', // POST success marker
    ],
  )
  assert.equal(emailState.sendCalls.length, 1)
})

test('built-in roles split email transport authority from user administration', () => {
  // admin.setup.manage must stay seedable so someone can actually hold it.
  assert.ok((PERMISSION_CATALOGUE as readonly string[]).includes('admin.setup.manage'))
  const holds = (role: string, perm: string) =>
    permissionSetCovers(new Set(BUILT_IN_ROLES[role]!.permissions), perm)
  // The controller owns org configuration (including the outbound transport)
  // but never people administration — the SoD this slice pins in.
  assert.equal(holds('controller', 'admin.setup.manage'), true)
  assert.equal(holds('controller', 'admin.users.manage'), false)
  // Full administrators keep both sides.
  assert.equal(holds('admin', 'admin.setup.manage'), true)
  assert.equal(holds('admin', 'admin.users.manage'), true)
})

// Register the three email-authority cases before awaiting route evaluation.
// With --test-force-exit, tests declared after a top-level await can be omitted
// from the run if the earlier queue drains first.
await emailRoutesReady

// --- Income-tax provision posting authorization ------------------------------
//
// Representative regression for POST /api/tax/provisions/[id]/post
// (fnd_mt985mgz_xcpku4, fnd_mt9ck2a5_rf7ofs): a provision post writes and
// reverses posted GL entries on the ROOT subsidiary, so the real handler must
// demand `gl.post` (never `reports.create`), load the run under org scope, and
// fence that root entity before engaging the kernel. The harness swaps the
// session/identity and database boundaries for scripted fakes and instruments
// the engine service boundary; guardPermission, guardSubsidiaryScope, the
// permission resolution they rest on, and the handler itself all run exactly
// as production runs them.

const PROVISION_POST_RUN_ID = '00000000-0000-4000-8000-00000000c001'
const PROVISION_POST_ROOT_ID = '00000000-0000-4000-8000-00000000c002'
const PROVISION_POST_CHILD_ID = '00000000-0000-4000-8000-00000000c003'
const PROVISION_POST_ORG_ID = 'org-provision-post'
const PROVISION_POST_USER_ID = 'user-provision-post'
const PROVISION_POST_ENTRY_ID = 'entry-provision-post'

interface ProvisionPostState {
  currentUser: Record<string, unknown> | null
  rolePermissions: string[]
  allowedSubsidiaryIds: Set<string> | null
  runExists: boolean
  rootSubsidiaryId: string | null
  dbCalls: string[]
  engineCalls: { orgId: string; runId: string; actorId: string }[]
}

const provisionPostState: ProvisionPostState = {
  currentUser: null,
  rolePermissions: ['gl.post'],
  allowedSubsidiaryIds: null,
  runExists: true,
  rootSubsidiaryId: PROVISION_POST_ROOT_ID,
  dbCalls: [],
  engineCalls: [],
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for('openbooks.provision-post-test')] =
  provisionPostState

/** Flatten a drizzle SQL chunk into its raw text for routing scripted replies. */
function provisionSqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks
  if (!Array.isArray(chunks)) return ''
  return chunks
    .map((c) => {
      if (typeof c === 'string') return c
      const value = (c as { value?: unknown[] })?.value
      if (Array.isArray(value)) return value.map(String).join('')
      if ((c as { queryChunks?: unknown[] })?.queryChunks) return provisionSqlText(c)
      return ''
    })
    .join('')
}
;(globalThis as typeof globalThis & Record<string, unknown>).openbooksProvisionPostSqlText = provisionSqlText

const provisionPostSources = new Map<string, string>([
  [
    'mock:provision-post-db',
    `
      const state = globalThis[Symbol.for('openbooks.provision-post-test')]
      const sqlText = globalThis.openbooksProvisionPostSqlText
      export const db = {
        execute: (query) => {
          const text = sqlText(query)
          state.dbCalls.push(text)
          if (text.includes('user_permission_overrides')) return Promise.resolve({ rows: [] })
          if (text.includes('role_assignments'))
            return Promise.resolve({ rows: [{ permissions: state.rolePermissions }] })
          if (text.includes('tax_provision_runs'))
            return Promise.resolve({ rows: state.runExists ? [{ id: 'row' }] : [] })
          if (text.includes('parent_id is null'))
            return Promise.resolve({
              rows: state.rootSubsidiaryId ? [{ id: state.rootSubsidiaryId }] : [],
            })
          return Promise.resolve({ rows: [] })
        },
        transaction: async (work) => work({}),
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
    `,
  ],
  [
    // The instrumented kernel boundary: every GL mutation this route can cause
    // funnels through postProvisionRun, so recording its invocations records
    // the engine writes.
    'mock:provision-post-engine',
    `
      const state = globalThis[Symbol.for('openbooks.provision-post-test')]
      export class IncomeTaxProvisionError extends Error {}
      export async function postProvisionRun(orgId, runId, actorId) {
        state.engineCalls.push({ orgId, runId, actorId })
        return { entryId: 'entry-provision-post' }
      }
    `,
  ],
  [
    'mock:provision-post-auth',
    `
      const state = globalThis[Symbol.for('openbooks.provision-post-test')]
      export async function currentUser() {
        return state.currentUser
      }
    `,
  ],
  [
    'mock:provision-post-subsidiaries',
    `
      const state = globalThis[Symbol.for('openbooks.provision-post-test')]
      export async function allowedSubsidiaryIds(_userId) {
        return state.allowedSubsidiaryIds
      }
    `,
  ],
])

const provisionPostHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        format: 'module',
        url: 'data:text/javascript,export function redirect(){throw new Error("redirect")}',
      }
    }
    if (specifier === '@openbooks/engine/src/db.ts') {
      return { url: 'mock:provision-post-db', shortCircuit: true }
    }
    if (specifier === '@openbooks/engine/src/income-tax-provision.ts') {
      return { url: 'mock:provision-post-engine', shortCircuit: true }
    }
    // authz.ts reaches these siblings as './auth'/'./subsidiaries'; the
    // suffixed forms cover direct deep imports from the route side.
    if (specifier === './auth' || specifier.endsWith('/lib/auth')) {
      return { url: 'mock:provision-post-auth', shortCircuit: true }
    }
    if (specifier === './subsidiaries' || specifier.endsWith('/lib/subsidiaries')) {
      return { url: 'mock:provision-post-subsidiaries', shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = provisionPostSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const provisionPostRouteUrl = '../app/api/tax/provisions/[id]/post/route.ts?provision-post-test'
const { POST: postProvisionRoute } = (await import(
  provisionPostRouteUrl
)) as typeof import('../app/api/tax/provisions/[id]/post/route.ts')
provisionPostHooks.deregister()

function resetProvisionPost(): void {
  provisionPostState.currentUser = {
    id: PROVISION_POST_USER_ID,
    orgId: PROVISION_POST_ORG_ID,
    isSuperAdmin: false,
  }
  provisionPostState.rolePermissions = ['gl.post']
  provisionPostState.allowedSubsidiaryIds = null
  provisionPostState.runExists = true
  provisionPostState.rootSubsidiaryId = PROVISION_POST_ROOT_ID
  provisionPostState.dbCalls.length = 0
  provisionPostState.engineCalls.length = 0
}

function postProvision(id: string): Promise<Response> {
  return postProvisionRoute(new Request(`http://openbooks.test/api/tax/provisions/${id}/post`, { method: 'POST' }), {
    params: Promise.resolve({ id }),
  })
}

test('the provision post route denies reports-only and out-of-scope principals before any write', async () => {
  resetProvisionPost()

  // Report authorship is not ledger authority: the gate names gl.post and
  // neither the scoped run read nor the kernel ever runs.
  provisionPostState.rolePermissions = ['reports.create']
  const forbidden = await postProvision(PROVISION_POST_RUN_ID)
  assert.equal(forbidden.status, 403)
  assert.deepEqual(await forbidden.json(), { error: 'missing permission: gl.post' })
  assert.deepEqual(provisionPostState.engineCalls, [], 'a reports-only principal causes zero engine writes')
  assert.ok(
    !provisionPostState.dbCalls.some((text) => text.includes('tax_provision_runs')),
    'the 403 precedes even the scoped run load',
  )

  // Unknown run and restricted-root deny with one indistinguishable 404 shape,
  // and both leave the kernel untouched — a child-restricted poster can neither
  // discover nor mutate the root-entity journal.
  provisionPostState.rolePermissions = ['gl.post']
  provisionPostState.runExists = false
  const unknownRun = await postProvision(PROVISION_POST_RUN_ID)
  assert.equal(unknownRun.status, 404)

  provisionPostState.runExists = true
  provisionPostState.allowedSubsidiaryIds = new Set([PROVISION_POST_CHILD_ID])
  const outOfScopeRoot = await postProvision(PROVISION_POST_RUN_ID)
  assert.equal(outOfScopeRoot.status, 404)
  assert.deepEqual(
    await outOfScopeRoot.json(),
    { error: 'not found' },
    'an out-of-scope root subsidiary is indistinguishable from a missing run',
  )
  assert.deepEqual(provisionPostState.engineCalls, [], 'neither denial reached the kernel')
})

test('an unrestricted gl.post holder posts the organization-wide provision through the real handler', async () => {
  resetProvisionPost()
  // Posting changes every entity represented in the consolidated run.
  provisionPostState.allowedSubsidiaryIds = null

  const response = await postProvision(PROVISION_POST_RUN_ID)

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { entryId: PROVISION_POST_ENTRY_ID })
  assert.deepEqual(
    provisionPostState.engineCalls,
    [{ orgId: PROVISION_POST_ORG_ID, runId: PROVISION_POST_RUN_ID, actorId: PROVISION_POST_USER_ID }],
    'exactly one kernel posting of the requested run, attributed to the caller',
  )
})
