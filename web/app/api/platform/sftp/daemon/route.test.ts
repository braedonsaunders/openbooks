import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

/**
 * The global SFTP daemon is a singleton row (id=default, no org) feeding one
 * in-process listener for EVERY tenant. Its mutation therefore belongs to the
 * platform super-admin authority at /api/platform/sftp/daemon — never to an
 * organization feature write on /api/banking/sftp/daemon.
 *
 * This suite pins the boundary end to end:
 *   - a tenant org admin (admin.setup.manage + Bank Feeds ON) is 403 on the
 *     platform mutation with no global config write, while the old tenant
 *     daemon route exports no PATCH at all and stays read-only;
 *   - ordinary tenant-owned SFTP server management remains available and
 *     org-scoped under its Bank Feeds gate;
 *   - a platform super-admin succeeds on the platform mutation.
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
    `,
  ],
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.platform-sftp-daemon-route-test')]
      const sqlText = globalThis.platformSftpDaemonSqlText
      export const db = {
        execute(query) {
          state.inserts.push({ text: sqlText(query) })
          return Promise.resolve({ rows: [{ id: 'server-1' }] })
        },
        transaction(fn) {
          return fn(db)
        },
      }
      export const schema = {}
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['@openbooks/engine/src/sftp/manager.ts', 'mock:sftp-manager'],
  ['@openbooks/engine/src/sftp/backend.ts', 'mock:sftp-backend'],
  ['@openbooks/engine/src/db.ts', 'mock:db'],
  ['../../../../../lib/feature-gates', 'mock:feature-gates'],
  ['../../../../lib/feature-gates', 'mock:feature-gates'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    // The server-only marker gates RSC bundling; shim it so server modules
    // load under the plain runner (same seam as expenses/[id]/route.test.ts).
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
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
  // with its secret-free audit evidence in the same transaction.
  assert.equal(routeState.inserts.length, 2)
  assert.match(routeState.inserts[0]!.text, /insert into sftp_servers/)
  assert.ok(
    routeState.inserts[0]!.text.includes('org-1'),
    `server insert must be scoped to the caller's org, got: ${routeState.inserts[0]!.text}`,
  )
  assert.match(routeState.inserts[1]!.text, /insert into audit_log/)
  assert.ok(
    routeState.inserts[1]!.text.includes('sftp_servers'),
    `login creation must leave audit evidence on sftp_servers, got: ${routeState.inserts[1]!.text}`,
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
