import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({
  resolve(specifier, _context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    return next(specifier)
  },
})

const { sql } = await import('drizzle-orm')
const { db, env, withBypass } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { loadDashboardLayout } = await import('./_load-layout')
const { DEFAULT_DASHBOARD_LAYOUTS } = await import('@openbooks/schema')

type Authz = Parameters<typeof loadDashboardLayout>[0]

async function adminAuthz(orgId: string, name: string): Promise<Authz> {
  const userId = await withBypass(() => createScratchUser(orgId, name, 'admin'))
  return {
    user: {
      id: userId,
      email: `u-${userId.slice(0, 8)}@scratch.test`,
      name,
      roles: [{ key: 'admin', name: 'admin' }],
      orgId,
      envKind: 'production',
      productionOrgId: orgId,
      isSuperAdmin: false,
      homeUserId: userId,
      homeOrgId: orgId,
    },
    permissions: new Set<string>(['*']),
    allowedSubsidiaryIds: null,
  } as Authz
}

async function storeLayout(orgId: string, userId: string, layout: unknown, sourceRole = 'tier:admin') {
  await withBypass(async () => {
    await db.execute(sql`insert into user_dashboard_layouts (id, org_id, user_id, layout, source_role, is_customised, created_at, updated_at)
      values (${randomUUID()}, ${orgId}, ${userId}, ${JSON.stringify(layout)}::jsonb, ${sourceRole}, true, now(), now())`)
  })
}

/**
 * Self-heal on read: the pre-fix quick-actions save persisted `{widgets: []}`
 * for tenants with no stored row. That row must fall back to the default
 * layout — never a blank dashboard. The next save overwrites the bad row.
 */
test('stored empty grid falls back to the default layout', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  try {
    const authz = await adminAuthz(org.orgId, 'Empty Grid')
    await storeLayout(org.orgId, authz.user.id, { widgets: [], quickActions: [] })
    const loaded = await loadDashboardLayout(authz)
    assert.deepEqual(loaded.layout.widgets, DEFAULT_DASHBOARD_LAYOUTS.admin.widgets)
    assert.equal(loaded.isCustomised, false)
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

test('malformed stored layout falls back to the default layout', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  try {
    const authz = await adminAuthz(org.orgId, 'Bad Shape')
    await storeLayout(org.orgId, authz.user.id, { widgets: 'nope', quickActions: 'also-nope' })
    const loaded = await loadDashboardLayout(authz)
    assert.deepEqual(loaded.layout.widgets, DEFAULT_DASHBOARD_LAYOUTS.admin.widgets)
    assert.equal(loaded.isCustomised, false)
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

test('valid stored layout is still honoured', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  try {
    const authz = await adminAuthz(org.orgId, 'Valid Grid')
    const widgets = DEFAULT_DASHBOARD_LAYOUTS.admin.widgets.slice(0, 2)
    await storeLayout(org.orgId, authz.user.id, { widgets })
    const loaded = await loadDashboardLayout(authz)
    assert.deepEqual(loaded.layout.widgets, widgets)
    assert.equal(loaded.isCustomised, true)
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})
