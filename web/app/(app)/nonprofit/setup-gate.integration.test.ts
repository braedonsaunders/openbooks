import { registerHooks } from 'node:module'
import { resolveAppModule } from '../../../../lib/test-module-hooks'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
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
const { withBypassContext, withOrgContext } = await import(root + 'engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrgReporting } = await import(root + 'engine/src/testing/fixtures.ts')
const { loadNonprofitSetup } = await import(root + 'web/app/(app)/nonprofit/setup/view.ts')
test('nonprofit setup with the feature off redirects to the Features explanation', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org: ScratchOrg = await withBypassContext(() => createScratchOrg())
  const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Setup reader', 'admin'))
  state.user = { id: actor, orgId: org.orgId, isSuperAdmin: false, name: 'Setup reader', email: 'setup-reader@scratch.test', roles: [], envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor }
  try {
    await assert.rejects(() => withOrgContext(org.orgId, () => loadNonprofitSetup()), (error: unknown) => String((error as { digest?: string }).digest ?? '').includes('/feature-required?feature=nonprofit'))
  } finally {
    state.user = null
    await dropScratchOrgReporting(org.orgId)
  }
})
