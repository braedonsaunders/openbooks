import { registerHooks } from 'node:module'
import { resolveAppModule } from '../../../../lib/test-module-hooks'
import { stubModules } from '../../../testing/stub-modules'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { sql } from 'drizzle-orm'
import test from 'node:test'
import type { ScratchOrg } from '@openbooks/engine/src/testing/fixtures.ts'
const root = pathToFileURL(process.cwd() + '/').href
const state: { user: import('../../../../lib/auth').SessionUser | null } = { user: null }
Object.assign(globalThis, { __nonprofitSetupGate: state })
registerHooks({
  resolve(s, c, next) {
    if ((s === './auth' || s.endsWith('/lib/auth')) && c.parentURL?.includes('/web/') && !c.parentURL.includes('/web/lib/auth.ts')) {
      return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(`export * from ${JSON.stringify(root + 'web/lib/auth.ts')};export async function currentUser(){return globalThis.__nonprofitSetupGate.user;}`) }
    }
    const app = resolveAppModule(s, c, next, root)
    if (app) return app
    return next(s, c)
  },
})
// Translations are request-scoped framework output, not the refusal under test:
// stub only next-intl while authz, feature flags, and the database stay real.
stubModules({ intl: true })
const { db, withBypassContext, withOrgContext } = await import(root + 'engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrgReporting } = await import(root + 'engine/src/testing/fixtures.ts')
const { loadNonprofitSetup } = await import(root + 'web/app/(app)/nonprofit/setup/view.ts')
const { loadNonprofit } = await import(root + 'web/app/(app)/nonprofit/view.ts')
// Shared scratch reader: each scenario gets a fresh org, actor, and cleanup.
async function withCockpitReader(displayName: string, email: string, superAdmin: boolean, fn: (org: ScratchOrg) => Promise<void>): Promise<void> {
  const org: ScratchOrg = await withBypassContext(() => createScratchOrg())
  const actor = await withBypassContext(() => createScratchUser(org.orgId, displayName, 'admin'))
  state.user = { id: actor, orgId: org.orgId, isSuperAdmin: superAdmin, name: displayName, email, roles: [], envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor }
  try {
    await fn(org)
  } finally {
    state.user = null
    await dropScratchOrgReporting(org.orgId)
  }
}
test('nonprofit setup with the feature off redirects to the Features explanation', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  await withCockpitReader('Setup reader', 'setup-reader@scratch.test', false, async (org) => {
    await assert.rejects(() => withOrgContext(org.orgId, () => loadNonprofitSetup()), (error: unknown) => String((error as { digest?: string }).digest ?? '').includes('/feature-required?feature=nonprofit'))
  })
})
test('nonprofit cockpit surfaces a refused fund tie-out with its exact remedy', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  await withCockpitReader('Tie-out reader', 'tieout-reader@scratch.test', true, async (org) => {
    const enabled = await withOrgContext(org.orgId, () => db.execute<{ id: string }>(sql`update orgs set settings=jsonb_set(coalesce(settings,'{}'::jsonb),'{features}',coalesce(settings->'features','{}'::jsonb)||'{"nonprofit":true,"fundAccounting":true}'::jsonb,true) where id=${org.orgId} returning id`))
    assert.equal(enabled.rows.length, 1)
    const data = await withOrgContext(org.orgId, () => loadNonprofit())
    assert.equal(data.hasTieout, false)
    const refusal = data.attention.find((entry) => entry.tone === 'negative')
    assert.deepEqual(refusal, {
      tone: 'negative',
      text: 'A nonprofit accounting framework has not been selected for this organization. Select a supported framework with setFramework before creating fund releases.',
      href: '/nonprofit/setup',
    })
  })
})
