import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

/**
 * The global SFTP daemon (singleton id=default, no org) feeds one listener
 * for EVERY tenant, so only the platform super-admin authority mutates it.
 * This suite pins: tenant admins 403 with no write (old tenant route
 * read-only); tenant servers stay org-scoped under Bank Feeds; super-admin
 * success; mid-write revocation gets the named 403 with no write, not a 500.
 */

interface DaemonPatch {
  enabled?: boolean
  port?: number
  advertisedHost?: string | null
}

interface RouteState {
  /** What the mocked identity source (lib/authz behind lib/super-admin) resolves. */
  identity:
    | null
    | {
        user: Record<string, unknown> & { id: string }
        permissions: Set<string>
        allowedSubsidiaryIds: Set<string> | null
      }
  updates: Array<{ patch: DaemonPatch; userId: string }>
  inserts: Array<{ text: string }>
  gateCalls: Array<{ permission: string; featureKey: string }>
}

const stateKey = Symbol.for('openbooks.platform-sftp-daemon-route-test')
const routeState: RouteState = {
  identity: null,
  updates: [],
  inserts: [],
  gateCalls: [],
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState

/** Flatten a drizzle SQL chunk into raw text for org-scoping assertions. */
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
;(globalThis as typeof globalThis & Record<string, unknown>).platformSftpDaemonSqlText = sqlText

const mockSources = new Map<string, string>([
  [
    // Identity source behind the REAL lib/super-admin authority under test.
    'mock:platform-authz',
    `
      const state = globalThis[Symbol.for('openbooks.platform-sftp-daemon-route-test')]
      export async function getAuthz() {
        return state.identity
      }
      export async function resolveUserAuthz(user) {
        if (state.identity && state.identity.user.id === user.id) return state.identity
        return { user, permissions: new Set(), allowedSubsidiaryIds: null }
      }
      export function can(authz, perm) {
        return authz.permissions.has(perm) || authz.permissions.has('*')
      }
    `,
  ],
  [
    // Tenant surfaces keep their established Bank Feeds feature gate.
    'mock:feature-gates',
    `
      const state = globalThis[Symbol.for('openbooks.platform-sftp-daemon-route-test')]
      export async function guardFeaturePermission(permission, featureKey) {
        state.gateCalls.push({ permission, featureKey })
        if (permission === 'admin.setup.manage' && featureKey === 'bankFeeds') {
          return {
            user: { orgId: 'org-1', id: 'user-org-admin', isSuperAdmin: false },
            permissions: new Set(['admin.setup.manage']),
            allowedSubsidiaryIds: null,
          }
        }
        throw new Error('unexpected feature gate: ' + permission + '/' + featureKey)
      }
    `,
  ],
  [
    'mock:sftp-manager',
    `
      const state = globalThis[Symbol.for('openbooks.platform-sftp-daemon-route-test')]
      export async function loadDaemonConfig() {
        return { enabled: false, port: 2022, advertisedHost: null, hostKey: 'test-host-key' }
      }
      export async function updateDaemonConfig(patch, userId) {
        state.updates.push({ patch, userId })
        return {
          enabled: patch.enabled ?? false,
          port: patch.port ?? 2022,
          advertisedHost: patch.advertisedHost ?? null,
          hostKey: 'test-host-key',
        }
      }
      export async function ensureSftpServer() {}
      export function hostKeyFingerprint(hostKey) {
        return 'fp:' + hostKey
      }
      export const encryptSecret = (plain) => 'enc:' + plain
      export const SFTP_AUDIT_REDACTED = '[redacted]'
      export function sftpServerAuditSnapshot(row) {
        return {
          name: row.name, username: row.username, backend: row.backend, bucket: row.bucket,
          root_prefix: row.root_prefix, is_active: row.is_active,
          password_encrypted: row.password_encrypted === null ? null : SFTP_AUDIT_REDACTED,
          authorized_keys: row.authorized_keys === null ? null : SFTP_AUDIT_REDACTED,
          created_by: row.created_by, updated_by: row.updated_by,
        }
      }
      export function sftpDaemonConfigAuditSnapshot(cfg) {
        return { enabled: cfg.enabled, port: cfg.port, advertised_host: cfg.advertisedHost }
      }
    `,
  ],
  [
    'mock:sftp-backend',
    `
      export function appStorageKind() {
        return 'local'
      }
      export function appBucket() {
        return null
      }
      export function assertTenantRootPrefix(rootPrefix, _orgId) {
        return rootPrefix
      }
    `,
  ],
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.platform-sftp-daemon-route-test')]
      const sqlText = globalThis.platformSftpDaemonSqlText
      export const db = {
        execute(query) {
          const text = sqlText(query); state.inserts.push({ text })
          return Promise.resolve({ rows: text.includes('from users') ? [{ id: state.identity?.user?.id ?? 'user-platform', orgId: 'org-platform', isActive: true, isSuperAdmin: state.identity?.user?.id === 'user-platform' }] : [{ id: 'server-1' }] })
        },
        transaction(fn) {
          return fn(db)
        },
      }
      export const schema = {}
      export const ambientTenantOrgId = () => null
      export const currentRequestOrgResolver = () => null
      export const registerRequestOrgResolver = () => {}
      export const withBypass = (_options, work) => work()
      export const withBypassContext = (work) => work()
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['@openbooks/engine/src/sftp/manager.ts', 'mock:sftp-manager'],
  ['@openbooks/engine/src/sftp/backend.ts', 'mock:sftp-backend'],
  ['@openbooks/engine/src/platform/db.ts', 'mock:db'],
  ['../../../../../lib/feature-gates', 'mock:feature-gates'],
  ['../../../../lib/feature-gates', 'mock:feature-gates'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    // load under the plain runner (same seam as expenses/[id]/route.test.ts).
    // Forward Next.js-style aliases to the real modules they point at,
    // anchored at this test's web root so every importing depth resolves
    // identically.
    if (specifier.startsWith('@/lib/') && context.parentURL) {
      return nextResolve(new URL(`../../../../../${specifier.slice(2)}.ts`, import.meta.url).href, context)
    }
    // The platform route exercises the REAL lib/super-admin guardSuperAdmin;
    // only its identity source is replaced so no session or database is needed.
    if (specifier === './authz' && context.parentURL?.endsWith('/lib/super-admin.ts')) {
      return { url: 'mock:platform-authz', shortCircuit: true }
    }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
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

const platformUrl = './route.ts?platform-sftp-daemon-test'
const { PATCH: platformPATCH } = (await import(platformUrl)) as typeof import('./route.ts')

const tenantDaemonUrl = '../../../banking/sftp/daemon/route.ts?sftp-daemon-readonly-test'
const tenantDaemonRoute = (await import(tenantDaemonUrl)) as typeof import('../../../banking/sftp/daemon/route.ts')

const tenantServersUrl = '../../../banking/sftp/route.ts?sftp-servers-org-scoped-test'
const { POST: tenantServerPOST } = (await import(tenantServersUrl)) as typeof import('../../../banking/sftp/route.ts')
hooks.deregister()

const ORG_ADMIN_AUTHZ = {
  user: { orgId: 'org-1', id: 'user-org-admin', isSuperAdmin: false },
  permissions: new Set(['admin.setup.manage']),
  allowedSubsidiaryIds: null,
}

const SUPER_ADMIN_AUTHZ = {
  user: { orgId: 'org-platform', id: 'user-platform', isSuperAdmin: true },
  permissions: new Set(['*']),
  allowedSubsidiaryIds: null,
}

function reset(): void {
  routeState.identity = null
  routeState.updates.length = 0
  routeState.inserts.length = 0
  routeState.gateCalls.length = 0
}

test('tenant authority cannot mutate the global daemon and the old tenant route is read-only', async () => {
  reset()
  routeState.identity = ORG_ADMIN_AUTHZ

  // An org setup admin with Bank Feeds ON hits the PLATFORM mutation…
  const denied = await platformPATCH(new Request('http://openbooks.test/api/platform/sftp/daemon', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  }))
  assert.equal(denied.status, 403)
  assert.deepEqual(await denied.json(), { error: 'forbidden' })

  // …and no global configuration write may have been attempted.
  assert.equal(routeState.updates.length, 0)

  // The old tenant route no longer exposes a mutation surface at all.
  assert.equal((tenantDaemonRoute as Record<string, unknown>).PATCH, undefined)

  // Its GET survives as the read-only connection-details surface, still gated.
  const read = await tenantDaemonRoute.GET(
    new Request('http://openbooks.test/api/banking/sftp/daemon', { method: 'GET' }),
  )
  assert.equal(read.status, 200)
  const details = (await read.json()) as { enabled: boolean; port: number; fingerprint: string }
  assert.equal(details.enabled, false)
  assert.equal(details.port, 2022)
  assert.equal(details.fingerprint, 'fp:test-host-key')
  assert.deepEqual(routeState.gateCalls, [{ permission: 'admin.setup.manage', featureKey: 'bankFeeds' }])
})

test('ordinary tenant SFTP server management stays available and org-scoped', async () => {
  reset()
  routeState.identity = ORG_ADMIN_AUTHZ

  const created = await tenantServerPOST(new Request('http://openbooks.test/api/banking/sftp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Branch SFTP' }),
  }))

  assert.equal(created.status, 200)
  const body = (await created.json()) as { id: string; username: string; password: string }
  assert.match(body.username, /^branch-sftp-/)
  assert.ok(body.password.length > 0)
  // The create still consults the per-tenant Bank Feeds gate…
  assert.deepEqual(routeState.gateCalls, [{ permission: 'admin.setup.manage', featureKey: 'bankFeeds' }])
  // …and writes the server row scoped to the caller's organization, together
  // with its secret-free audit evidence in the same transaction. The create
  // first takes the per-org advisory lock and reads the active sibling
  // roots for the overlap gate, so four statements run in order: lock,
  // sibling read, scoped server insert, audit insert.
  assert.equal(routeState.inserts.length, 4)
  assert.match(routeState.inserts[0]!.text, /pg_advisory_xact_lock/)
  assert.ok(
    routeState.inserts[0]!.text.includes('sftp-roots:org-1'),
    `the advisory lock must serialize this org's creates, got: ${routeState.inserts[0]!.text}`,
  )
  assert.match(routeState.inserts[1]!.text, /from sftp_servers/)
  assert.ok(
    routeState.inserts[1]!.text.includes('org-1'),
    `the sibling overlap read must be scoped to the caller's org, got: ${routeState.inserts[1]!.text}`,
  )
  assert.match(routeState.inserts[2]!.text, /insert into sftp_servers/)
  assert.ok(
    routeState.inserts[2]!.text.includes('org-1'),
    `server insert must be scoped to the caller's org, got: ${routeState.inserts[2]!.text}`,
  )
  assert.match(routeState.inserts[3]!.text, /insert into audit_log/)
  assert.ok(
    routeState.inserts[3]!.text.includes('sftp_servers'),
    `login creation must leave audit evidence on sftp_servers, got: ${routeState.inserts[3]!.text}`,
  )
})

test('a platform super-admin can configure the global daemon', async () => {
  reset()
  routeState.identity = SUPER_ADMIN_AUTHZ

  const response = await platformPATCH(new Request('http://openbooks.test/api/platform/sftp/daemon', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true, port: 2222, advertisedHost: ' sftp.example.com ' }),
  }))

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    ok: true,
    enabled: true,
    port: 2222,
    advertisedHost: 'sftp.example.com',
  })
  assert.deepEqual(routeState.updates, [{
    patch: { enabled: true, port: 2222, advertisedHost: 'sftp.example.com' },
    userId: 'user-platform',
  }])
})

test('a super-admin revoked before the write gets the named refusal, not a 500', async () => {
  reset()
  routeState.identity = { ...SUPER_ADMIN_AUTHZ, user: { ...SUPER_ADMIN_AUTHZ.user, id: 'user-revoked' } }
  const response = await platformPATCH(new Request('http://openbooks.test/api/platform/sftp/daemon', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  }))
  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), { error: 'Platform super-admin access was revoked — reload and retry with an active super administrator' })
  assert.equal(routeState.updates.length, 0)
})
