import assert from 'node:assert/strict'
import test from 'node:test'
import { stubModules } from '../../../testing/stub-modules'
import type { SessionUser } from '../../../lib/auth'

const state: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __partiesNoRoleUser: state })
stubModules({ intl: true, navigation: false, authz: false, features: false })

// The session double stays conditioned: it answers only the authz module's
// own auth import, which no shared stub shape matches.
const { registerHooks: registerSessionHook } = await import('node:module')
registerSessionHook({
  resolve(specifier, context, next) {
    if ((specifier === './auth' || specifier.endsWith('/lib/auth')) && context.parentURL?.endsWith('/web/lib/authz.ts')) {
      return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent('export async function currentUser(){return globalThis.__partiesNoRoleUser.user}') }
    }
    return next(specifier, context)
  },
})
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { loadParties } = await import('./view')

const sessionFor = (orgId: string, actor: string): SessionUser => ({
  id: actor, orgId, name: 'Loader', email: 'loader@scratch.test',
  roles: [], isSuperAdmin: false, envKind: 'production',
  productionOrgId: orgId, homeOrgId: orgId, homeUserId: actor,
})

test('the party directory filters role-less parties behind role=no-role', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  const reader = await withBypassContext(() => createScratchUser(org.orgId, 'Reader', 'reader'))
  try {
    await withBypassContext(() =>
      db.execute(sql`update app_roles set permissions='["parties.read"]'::jsonb where org_id=${org.orgId} and key='reader'`),
    )
    await withBypassContext(() => db.execute(sql`
      insert into parties (org_id, kind, display_name, is_active, custom)
      values (${org.orgId}, 'company', 'Role-less Co', true, '{}'::jsonb),
             (${org.orgId}, 'company', 'Customer Co', true, '{}'::jsonb)`))
    const customerId = (await withBypassContext(() => db.execute<{ id: string }>(sql`
      select id from parties where org_id=${org.orgId} and display_name='Customer Co'`))).rows[0]!.id
    await withBypassContext(() => db.execute(sql`
      insert into customer_roles (org_id, party_id, is_active, created_by, updated_by)
      values (${org.orgId}, ${customerId}, true, ${reader}, ${reader})`))
    state.user = sessionFor(org.orgId, reader)

    const unfiltered = await withOrgContext(org.orgId, () => loadParties({}))
    assert.equal(unfiltered.total, 2)
    assert.equal(unfiltered.roleOptions.find((o) => o.value === 'no-role')?.count, 1)

    const roleless = await withOrgContext(org.orgId, () => loadParties({ role: 'no-role' }))
    assert.equal(roleless.total, 1)
    assert.equal(roleless.rows.length, 1)
    assert.equal(roleless.rows[0]!.name, 'Role-less Co')
    assert.deepEqual(roleless.rows[0]!.roleBadges, [])
    assert.equal(roleless.showAssignRole, false, 'readers never see the bulk action')

    const customers = await withOrgContext(org.orgId, () => loadParties({ role: 'customer' }))
    assert.equal(customers.total, 1)
    assert.equal(customers.rows[0]!.name, 'Customer Co')
  } finally {
    state.user = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('managers see bulk assignment only on the role-less slice', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  const manager = await withBypassContext(() => createScratchUser(org.orgId, 'Manager', 'manager'))
  try {
    await withBypassContext(() =>
      db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='manager'`),
    )
    await withBypassContext(() => db.execute(sql`
      insert into parties (org_id, kind, display_name, is_active, custom)
      values (${org.orgId}, 'company', 'Role-less Co', true, '{}'::jsonb)`))
    state.user = sessionFor(org.orgId, manager)

    const roleless = await withOrgContext(org.orgId, () => loadParties({ role: 'no-role' }))
    assert.equal(roleless.showAssignRole, true)
    assert.equal(roleless.assignTotal, 1)
    assert.deepEqual(roleless.assignRoles.map((r) => r.value), ['customer', 'vendor', 'employee'])

    const all = await withOrgContext(org.orgId, () => loadParties({}))
    assert.equal(all.showAssignRole, false, 'the bulk action stays off the unfiltered directory')
  } finally {
    state.user = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
