import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// The True Cost loader's gates: `reports.read` first, then the `projects`
// feature, before any period or cost query runs. Auth resolves for real
// against scratch roles and overrides — only the session identity (cookies)
// and platform seams (translations, navigation) are scripted. Postgres is
// live.
//
// The loader's subsidiary fence has no cheap distinguishing interface: it is
// threaded straight into trueCostData, whose `subsidiary_id in (fence)`
// semantics are owned by the reader's own integration tests in
// web/lib/analytics. These tests pin the two refusals.
const stateKey = Symbol.for('openbooks.true-cost-permission-test')
const state: { user: unknown | null } = { user: null }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

const mockAuth = `
  const state = globalThis[Symbol.for('openbooks.true-cost-permission-test')]
  export async function currentUser() { return state.user }
`
const mockNavigation = `
  export function redirect(to) { throw new Error('NEXT_REDIRECT:' + to) }
`
const mockIntl = `
  export async function getTranslations() { return (key) => key }
  export async function getLocale() { return 'en' }
`

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) {
      return { url: 'mock:true-cost-auth', shortCircuit: true }
    }
    if (specifier === 'next/navigation') {
      return { url: 'mock:true-cost-navigation', shortCircuit: true }
    }
    if (specifier === 'next-intl/server') {
      return { url: 'mock:true-cost-intl', shortCircuit: true }
    }
    if (context.parentURL?.startsWith('mock:')) {
      return nextResolve(specifier, { ...context, parentURL: import.meta.url })
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:true-cost-auth') return { format: 'module', source: mockAuth, shortCircuit: true }
    if (url === 'mock:true-cost-navigation') return { format: 'module', source: mockNavigation, shortCircuit: true }
    if (url === 'mock:true-cost-intl') return { format: 'module', source: mockIntl, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const { loadTrueCost } = await import('./view.ts')
const { sql } = await import('drizzle-orm')
const { db, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  '@openbooks/engine/src/testing/fixtures.ts'
)

function sessionUser(orgId: string, userId: string): unknown {
  return {
    id: userId,
    email: `${userId}@test`,
    name: 'True Cost Reader',
    roles: [],
    orgId,
    envKind: 'sandbox',
    productionOrgId: orgId,
    isSuperAdmin: false,
    homeUserId: userId,
    homeOrgId: orgId,
  }
}

async function freshReader(): Promise<{ orgId: string; userId: string }> {
  const org = await withBypass(() => createScratchOrg())
  // Fresh scratch roles carry no permissions, and scratch orgs enable no
  // features: the reader starts with nothing, grants are added per test.
  const userId = (await withBypass(() => createScratchUser(org.orgId, 'True Cost Reader', 'true_cost_reader'))) as unknown as string
  state.user = sessionUser(org.orgId, userId)
  return { orgId: org.orgId, userId }
}

async function grant(orgId: string, userId: string, permission: string): Promise<void> {
  await withBypass(() => db.execute(sql`insert into user_permission_overrides (user_id, org_id, permission, effect)
    values (${userId}, ${orgId}, ${permission}, 'grant')`))
}

async function enableProjects(orgId: string): Promise<void> {
  await withBypass(() => db.execute(
    sql`update orgs set settings = '{"features": {"projects": true}}'::jsonb where id = ${orgId}`,
  ))
}

test('a reader without reports.read is sent to access-denied naming the permission', async () => {
  const { orgId } = await freshReader()
  try {
    await assert.rejects(
      withOrgContext(orgId, () => loadTrueCost({})),
      /NEXT_REDIRECT:\/access-denied\?permission=reports\.read/,
    )
  } finally {
    state.user = null
    await withBypass(() => dropScratchOrg(orgId))
  }
})

async function disableProjects(orgId: string): Promise<void> {
  await withBypass(() => db.execute(
    sql`update orgs set settings = '{"features": {"projects": false}}'::jsonb where id = ${orgId}`,
  ))
}

test('a gated reader with projects explicitly off is sent to the feature gate', async () => {
  const { orgId, userId } = await freshReader()
  try {
    await grant(orgId, userId, 'reports.read')
    // Projects defaults on: only an explicit off flips the gate.
    await disableProjects(orgId)
    await assert.rejects(
      withOrgContext(orgId, () => loadTrueCost({})),
      /NEXT_REDIRECT:\/feature-required\?feature=projects/,
    )
  } finally {
    state.user = null
    await withBypass(() => dropScratchOrg(orgId))
  }
})

test('a gated reader with the feature loads the dashboard shell', async () => {
  const { orgId, userId } = await freshReader()
  try {
    await grant(orgId, userId, 'reports.read')
    await enableProjects(orgId)
    const data = await withOrgContext(orgId, () => loadTrueCost({}))
    assert.equal(data.reportHref, '/reports/true-cost', 'no query in, no query out')
    assert.ok(data.data, 'the dashboard carries its cost payload')
  } finally {
    state.user = null
    await withBypass(() => dropScratchOrg(orgId))
  }
})
