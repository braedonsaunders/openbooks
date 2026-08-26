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

test('an authorized gl.post holder in scope posts through the real handler', async () => {
  resetProvisionPost()
  // Restricted to exactly the root subsidiary the kernel posts into.
  provisionPostState.allowedSubsidiaryIds = new Set([PROVISION_POST_ROOT_ID])

  const response = await postProvision(PROVISION_POST_RUN_ID)

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { entryId: PROVISION_POST_ENTRY_ID })
  assert.deepEqual(
    provisionPostState.engineCalls,
    [{ orgId: PROVISION_POST_ORG_ID, runId: PROVISION_POST_RUN_ID, actorId: PROVISION_POST_USER_ID }],
    'exactly one kernel posting of the requested run, attributed to the caller',
  )
})
