import { registerHooks } from 'node:module'
import { randomUUID } from 'node:crypto'
import { resolveAppModule } from '../../../lib/test-module-hooks'
import { stubModules } from '../../../testing/stub-modules'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { sql } from 'drizzle-orm'
import test from 'node:test'
import type { ScratchOrg } from '@openbooks/engine/src/testing/fixtures.ts'
const root = pathToFileURL(process.cwd() + '/').href
const state: { user: import('../../../lib/auth').SessionUser | null } = { user: null }
Object.assign(globalThis, { __registerScope: state, __encDetailCalls: 0 })
const encReal = root + 'engine/src/nonprofit/encumbrances.ts'
registerHooks({
  resolve(s, c, next) {
    if ((s === './auth' || s.endsWith('/lib/auth')) && c.parentURL?.includes('/web/') && !c.parentURL.includes('/web/lib/auth.ts')) {
      return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(`export * from ${JSON.stringify(root + 'web/lib/auth.ts')};export async function currentUser(){return globalThis.__registerScope.user;}`) }
    }
    if (s === '@openbooks/engine/src/nonprofit/encumbrances.ts') return { shortCircuit: true, url: 'mock:enc-detail-counter' }
    const app = resolveAppModule(s, c, next, root)
    if (app) return app
    return next(s, c)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:enc-detail-counter') return { format: 'module', source: `export * from ${JSON.stringify(encReal)};import { getEncumbranceDetail as realDetail } from ${JSON.stringify(encReal)};export async function getEncumbranceDetail(...args){globalThis.__encDetailCalls += 1;return realDetail(...args)}`, shortCircuit: true }
    return nextLoad(url, context)
  },
})
// Translations are request-scoped framework output: stub only next-intl while
// authz, feature flags, and the database stay real.
stubModules({ intl: true })
const { db, withBypassContext, withOrgContext } = await import(root + 'engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrgReporting } = await import(root + 'engine/src/testing/fixtures.ts')
const { createEncumbrance } = await import(root + 'engine/src/nonprofit/encumbrances.ts')
const { loadGrants, grantsSpec } = await import(root + 'web/app/(app)/nonprofit/grants/view.ts')
const { loadEncumbrances, encumbrancesSpec } = await import(root + 'web/app/(app)/nonprofit/encumbrances/view.ts')
// One shared restricted reader: Uptown is the only subsidiary outside Main Co,
// the single named subsidiary the fixtures provision.
async function withScopedReader(permission: string, fn: (ctx: { org: ScratchOrg; outside: string; encId: string }) => Promise<void>): Promise<void> {
  const org: ScratchOrg = await withBypassContext(() => createScratchOrg())
  const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Scope reader', 'scope-reader'))
  const outside = (await withBypassContext(() => db.execute<{ id: string }>(sql`
    insert into subsidiaries (id, org_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (${randomUUID()}, ${org.orgId}, 'Uptown', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb) returning id`))).rows[0]!.id
  await withBypassContext(() => db.execute(sql`update app_roles set permissions = ${JSON.stringify([permission])}::jsonb,
    subsidiary_restriction = ${JSON.stringify({ mode: 'list', subsidiaryIds: [outside] })}::jsonb where org_id = ${org.orgId} and key = 'scope-reader'`))
  await withBypassContext(() => db.execute(sql`update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}',
    coalesce(settings->'features', '{}'::jsonb) || '{"nonprofit":true,"fundAccounting":true,"grantManagement":true,"encumbrances":true}'::jsonb, true)
    where id = ${org.orgId}`))
  const encId = await withOrgContext(org.orgId, async () => (await createEncumbrance({ orgId: org.orgId, amount: '40.00',
    accountId: org.accounts.cogs, subsidiaryId: org.subsidiaryId, extraDims: {} })).id)
  state.user = { id: actor, orgId: org.orgId, isSuperAdmin: false, name: 'Scope reader', email: 'scope-reader@scratch.test', roles: ['scope-reader'], envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor }
  try {
    await fn({ org, outside, encId })
  } finally {
    state.user = null
    await dropScratchOrgReporting(org.orgId)
  }
}
test('a subsidiary-restricted caller is refused the grant register with its remedy and no list', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  await withScopedReader('grants.read', async ({ org }) => {
    const data = await withOrgContext(org.orgId, () => loadGrants({}))
    assert.equal(data.scopeDenied, true)
    assert.equal(data.drawer, null)
    const flat = JSON.stringify(grantsSpec(data))
    assert.ok(!flat.includes('entity-list-view'), 'the denied register renders no list')
    assert.ok(flat.includes('scopeDeniedMessage'), 'the denied register carries the remedy message')
  })
})
test('an out-of-scope commitment loads no detail, links, figures, or candidates', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  await withScopedReader('encumbrances.read', async ({ org, encId }) => {
    ;(globalThis as Record<string, unknown>).__encDetailCalls = 0
    const data = await withOrgContext(org.orgId, () => loadEncumbrances({ encumbrance: encId }))
    assert.equal(data.drawer, null)
    assert.equal((globalThis as Record<string, unknown>).__encDetailCalls, 0, 'hidden detail is never loaded')
  })
})
test('lifting the restriction loads the commitment detail exactly once', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  await withScopedReader('encumbrances.read', async ({ org, encId }) => {
    await withBypassContext(() => db.execute(sql`update app_roles set subsidiary_restriction = '{"mode":"all"}'::jsonb
      where org_id = ${org.orgId} and key = 'scope-reader'`))
    ;(globalThis as Record<string, unknown>).__encDetailCalls = 0
    const data = await withOrgContext(org.orgId, () => loadEncumbrances({ encumbrance: encId }))
    assert.equal(data.drawer?.mode, 'record')
    assert.equal((globalThis as Record<string, unknown>).__encDetailCalls, 1, 'the counter observes real loads')
  })
})
test('commitment creation offers only subsidiaries in scope', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  await withScopedReader('encumbrances.read', async ({ org, outside }) => {
    const data = await withOrgContext(org.orgId, () => loadEncumbrances({ encumbrance: 'new' }))
    assert.equal(data.drawer?.mode, 'create')
    const options = data.drawer?.mode === 'create' ? data.drawer.subsidiaryOptions : []
    assert.deepEqual(options.map((option) => option.id), [outside])
    assert.ok(!options.some((option) => option.name === 'Main Co'), 'hidden subsidiary names stay absent')
  })
})
