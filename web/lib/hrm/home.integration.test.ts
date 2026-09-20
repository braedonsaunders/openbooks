import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { resolveAppModule } from '../test-module-hooks'
import type { SessionUser } from '../auth'

// Live-Postgres regression for the HRM overview LOADER. alpha.19 shipped a
// cockpit whose every test read the source as text, and its 30-day window
// query bound the window length as an untyped parameter: PostgreSQL refused
// `date + unknown` ("operator is not unique") and the page threw for every
// viewer in production. Nothing short of executing the loader against a real
// database can catch that class, so this test does exactly that.

const root = pathToFileURL(process.cwd() + '/').href
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    if (specifier === 'next-intl/server') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,' + encodeURIComponent(
          'export async function getTranslations(){const t=(k)=>k;t.has=()=>false;t.raw=(k)=>k;return t};export async function getLocale(){return "en"}',
        ),
      }
    }
    const app = resolveAppModule(specifier, context, next, root)
    if (app) return app
    return next(specifier, context)
  },
})
const { sql } = await import('drizzle-orm')
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { loadHrmHome } = await import('./home')

const DB = !!process.env.OPENBOOKS_DB_URL

test('the HRM overview loader executes every one of its queries against a live database', { skip: !DB }, async () => {
  // Wrapped, not listed: scripts/check-test-bypass-scope.test.mjs flags a bare
  // seeding call because a web test's import graph can replace the bypass
  // resolver process-wide, leaving setup to run under RLS.
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'HRM overview reader', 'hrm_overview_reader'))
    // The engine read services resolve the actor's grants from app_roles
    // themselves; the session Authz below is only the page-side view.
    await withBypassContext(() =>
      db.execute(sql`update app_roles set permissions = '["*"]'::jsonb where org_id = ${org.orgId} and key = 'hrm_overview_reader'`),
    )
    await withBypassContext(() =>
      db.execute(sql`
        update orgs
           set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}',
                                    coalesce(settings -> 'features', '{}'::jsonb) || '{"hrm": true}'::jsonb)
         where id = ${org.orgId}`),
    )
    const user: SessionUser = {
      id: actor,
      orgId: org.orgId,
      name: 'HRM overview reader',
      email: 'hrm-overview@scratch.test',
      roles: [],
      isSuperAdmin: false,
      envKind: 'production',
      productionOrgId: org.orgId,
      homeOrgId: org.orgId,
      homeUserId: actor,
    }
    // Every grant, so every optional section of the cockpit (positions,
    // queue, directory) takes its live path rather than its gated null.
    const authz = { user, permissions: new Set(['*']), allowedSubsidiaryIds: null }

    const data = await withOrgContext(org.orgId, () => loadHrmHome(authz))

    // A fresh org: zero of everything, and every panel present with its
    // own empty state resolved (the catalogue key, under the i18n shim).
    assert.equal(data.headcountValue, '0')
    assert.equal(data.total, 0)
    assert.deepEqual(data.groups, [])
    assert.deepEqual(data.starts, [])
    assert.deepEqual(data.ends, [])
    assert.equal(data.upcomingTruncated, false)
    assert.deepEqual(data.recent, [])
    assert.deepEqual(data.pending, [])
    assert.equal(data.pendingRefusal, null)
    assert.equal(data.pendingValue, '0')
    assert.equal(data.readinessTone, 'positive')
    assert.ok(data.positions, 'the position summary rides the cockpit for a viewer with hrm.position.read')
    assert.equal(data.positions.totals.positions, 0)
    assert.ok(data.tabs.some((tab) => tab.href === '/hrm' && tab.active), 'the overview tab is active on the overview')
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
