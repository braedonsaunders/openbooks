import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

/**
 * POST /api/platform/organizations is platform super-admin authority only.
 * Tenant administrators and anonymous callers are refused before the engine
 * command runs; a malformed body never reaches it; the engine's typed
 * refusals reach the operator with their code and remedy; and the first
 * administrator's access is the native set-password link, returned once
 * only when no mailbox carried it.
 */

interface CreateCall {
  name: string
  country: string
  currency: string
  administrator: { name: string; email: string }
  actorId: string
  reason: string
}

interface RouteState {
  identity: null | {
    user: Record<string, unknown> & { id: string; homeUserId: string; isSuperAdmin: boolean; orgId: string }
    permissions: Set<string>
    allowedSubsidiaryIds: Set<string> | null
  }
  createCalls: CreateCall[]
  createRefusal: null | { message: string; code: string; field: string; remedy: string; status: number }
  issuance: null | { raw: string; emailQueued: boolean }
  issuanceRefusal: null | { error: string; status: 403 | 409 }
  issueCalls: Array<{ user: { id: string; org_id: string; email: string } }>
}

const stateKey = Symbol.for('openbooks.platform-organizations-route-test')
const routeState: RouteState = {
  identity: null,
  createCalls: [],
  createRefusal: null,
  issuance: null,
  issuanceRefusal: null,
  issueCalls: [],
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState

const mockSources = new Map<string, string>([
  [
    // Identity source behind the REAL lib/super-admin authority under test.
    'mock:platform-authz',
    `
      const state = globalThis[Symbol.for('openbooks.platform-organizations-route-test')]
      export async function getAuthz() {
        return state.identity
      }
      export async function resolveUserAuthz(user) {
        return { user, permissions: new Set(), allowedSubsidiaryIds: null }
      }
      export function can(authz, perm) {
        return authz.permissions.has(perm) || authz.permissions.has('*')
      }
    `,
  ],
  [
    'mock:organization-provisioning',
    `
      const state = globalThis[Symbol.for('openbooks.platform-organizations-route-test')]
      export class OrganizationProvisioningError extends Error {
        constructor(input) {
          super(input.message)
          this.name = 'OrganizationProvisioningError'
          this.status = input.status
          this.code = input.code
          this.field = input.field
          this.remedy = input.remedy
        }
      }
      export async function lockPendingAdministrator() {
        return true
      }
      export async function createOrganization(input) {
        state.createCalls.push(input)
        if (state.createRefusal) throw new OrganizationProvisioningError(state.createRefusal)
        return {
          orgId: 'org-new',
          name: input.name,
          country: input.country,
          currency: input.currency,
          bookId: 'book-1',
          calendarId: 'calendar-1',
          subsidiaryId: 'subsidiary-1',
          firstFiscalYear: 2024,
          lastFiscalYear: 2031,
          administrator: { userId: 'user-new-admin', name: input.administrator.name, email: input.administrator.email, roleId: 'role-admin' },
        }
      }
    `,
  ],
  [
    'mock:auth-reset',
    `
      const state = globalThis[Symbol.for('openbooks.platform-organizations-route-test')]
      export class InviteIssuanceRefusedError extends Error {
        constructor(refusal) {
          super(refusal.error)
          this.name = 'InviteIssuanceRefusedError'
          this.refusal = { ...refusal, status: refusal.status ?? 403 }
        }
      }
      export async function issueInviteSetPasswordLink(input) {
        state.issueCalls.push({ user: input.user })
        if (state.issuanceRefusal) throw new InviteIssuanceRefusedError(state.issuanceRefusal)
        return state.issuance
      }
      export function setPasswordUrl(raw) {
        return 'https://books.example.test/login/reset?token=' + raw
      }
    `,
  ],
  [
    'mock:db',
    `
      export const db = {
        execute() {
          return Promise.resolve({ rows: [] })
        },
        transaction(fn) {
          return fn(db)
        },
      }
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['@openbooks/engine/provisioning/organizations', 'mock:organization-provisioning'],
  ['@openbooks/engine/platform/database', 'mock:db'],
  ['../../../../lib/auth-reset', 'mock:auth-reset'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './authz' && context.parentURL?.endsWith('/lib/super-admin.ts')) {
      return { url: 'mock:platform-authz', shortCircuit: true }
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

const routeUrl = './route.ts?platform-organizations-test'
const { POST } = (await import(routeUrl)) as typeof import('./route.ts')
test.after(() => hooks.deregister())

const TENANT_ADMIN = {
  user: { id: 'user-tenant-admin', homeUserId: 'user-tenant-admin', orgId: 'org-1', isSuperAdmin: false },
  permissions: new Set(['*']),
  allowedSubsidiaryIds: null,
}

const SUPER_ADMIN = {
  // Acting inside another organization: the accountable actor is the home identity.
  user: { id: 'user-acting', homeUserId: 'user-platform', orgId: 'org-platform', isSuperAdmin: true },
  permissions: new Set(['*']),
  allowedSubsidiaryIds: null,
}

const VALID_BODY = {
  name: '  Northwind Holdings  ',
  country: 'ca',
  currency: 'cad',
  adminName: 'Jordan Lee',
  adminEmail: ' Jordan.Lee@Northwind.Example ',
  reason: 'New customer onboarding',
}

function reset(): void {
  routeState.identity = null
  routeState.createCalls.length = 0
  routeState.createRefusal = null
  routeState.issuance = null
  routeState.issuanceRefusal = null
  routeState.issueCalls.length = 0
}

function post(body: unknown): Promise<Response> {
  return POST(new Request('http://openbooks.test/api/platform/organizations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

test('a tenant administrator and an anonymous caller cannot create organizations', async () => {
  reset()
  routeState.identity = TENANT_ADMIN
  const forbidden = await post(VALID_BODY)
  assert.equal(forbidden.status, 403)
  assert.deepEqual(await forbidden.json(), { error: 'forbidden' })

  routeState.identity = null
  const anonymous = await post(VALID_BODY)
  assert.equal(anonymous.status, 401)

  assert.equal(routeState.createCalls.length, 0)
  assert.equal(routeState.issueCalls.length, 0)
})

test('a malformed request is refused before the engine command runs', async () => {
  reset()
  routeState.identity = SUPER_ADMIN
  for (const body of [
    { ...VALID_BODY, country: 'XX' },
    { ...VALID_BODY, currency: 'ZZZ' },
    { ...VALID_BODY, adminEmail: 'not-an-address' },
    { ...VALID_BODY, reason: '  ' },
    { ...VALID_BODY, password: 'never-accepted' },
  ]) {
    const response = await post(body)
    assert.equal(response.status, 400, JSON.stringify(body))
  }
  assert.equal(routeState.createCalls.length, 0)
})

test('a super administrator creates the organization and receives the one-time link only without email', async () => {
  reset()
  routeState.identity = SUPER_ADMIN
  routeState.issuance = { raw: 'raw-token', emailQueued: false }

  const response = await post(VALID_BODY)
  assert.equal(response.status, 201)
  assert.deepEqual(await response.json(), {
    ok: true,
    orgId: 'org-new',
    name: 'Northwind Holdings',
    administrator: { userId: 'user-new-admin', email: 'jordan.lee@northwind.example' },
    emailQueued: false,
    setPasswordUrl: 'https://books.example.test/login/reset?token=raw-token',
  })
  assert.deepEqual(routeState.createCalls, [{
    name: 'Northwind Holdings',
    country: 'CA',
    currency: 'CAD',
    administrator: { name: 'Jordan Lee', email: 'jordan.lee@northwind.example' },
    actorId: 'user-platform',
    reason: 'New customer onboarding',
  }])
  assert.deepEqual(routeState.issueCalls.map((call) => call.user.org_id), ['org-new'])

  reset()
  routeState.identity = SUPER_ADMIN
  routeState.issuance = { raw: 'raw-token', emailQueued: true }
  const emailed = await post(VALID_BODY)
  assert.equal(emailed.status, 201)
  const body = (await emailed.json()) as Record<string, unknown>
  assert.equal(body.emailQueued, true)
  assert.equal('setPasswordUrl' in body, false, 'an emailed link is never also returned to the operator')
})

test('engine refusals reach the operator with their code and remedy', async () => {
  reset()
  routeState.identity = SUPER_ADMIN
  routeState.createRefusal = {
    message: 'an organization named "Northwind Holdings" already exists',
    status: 409,
    code: 'organization_name_taken',
    field: 'name',
    remedy: 'Choose a different name.',
  }
  const response = await post(VALID_BODY)
  assert.equal(response.status, 409)
  const body = (await response.json()) as Record<string, unknown>
  assert.equal(body.error, 'an organization named "Northwind Holdings" already exists')
  assert.equal(body.code, 'organization_name_taken')
  assert.equal(body.field, 'name')
  assert.equal(body.remedy, 'Choose a different name.')
  assert.equal(routeState.issueCalls.length, 0)
})

test('a link refusal after creation names the created organization and the remedy', async () => {
  reset()
  routeState.identity = SUPER_ADMIN
  routeState.issuanceRefusal = { error: 'Platform super-admin access was revoked', status: 403 }
  const refused = await post(VALID_BODY)
  assert.equal(refused.status, 403)
  const body = (await refused.json()) as Record<string, unknown>
  assert.equal(body.orgId, 'org-new')
  assert.match(String(body.remedy), /re-send the invitation/)

  reset()
  routeState.identity = SUPER_ADMIN
  routeState.issuance = null
  const capped = await post(VALID_BODY)
  assert.equal(capped.status, 429)
  assert.equal(((await capped.json()) as Record<string, unknown>).orgId, 'org-new')
})
