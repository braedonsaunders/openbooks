import { registerHooks } from 'node:module'
import { resolveAppModule } from '../../../../lib/test-module-hooks'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import * as React from 'react'
import type { ScratchOrg } from '../../../../../engine/src/testing/fixtures.ts'
const repo = process.cwd()
const root = pathToFileURL(repo + '/').href
const state: { user: import('../../../../lib/auth').SessionUser | null } = { user: null }
Object.assign(globalThis, { __pspPermsState: state, React })
registerHooks({
  resolve(s, c, next) {
    if (s === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    if (s === 'next-intl/server') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,' + encodeURIComponent(
          'export async function getTranslations(){const t=(k,p)=>p===undefined?k:`${k} ${JSON.stringify(p)}`;t.has=()=>false;t.rich=(k)=>k;return t;};export async function getLocale(){return "en"}',
        ),
      }
    }
    if ((s === './auth' || s.endsWith('/lib/auth')) && c.parentURL?.includes('/web/') && !c.parentURL.includes('/web/lib/auth.ts')) {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,' + encodeURIComponent(
          `export * from ${JSON.stringify(root + 'web/lib/auth.ts')};export async function currentUser(){return globalThis.__pspPermsState.user;}`,
        ),
      }
    }
    const app = resolveAppModule(s, c, next, root)
    if (app) return app
    return next(s, c)
  },
})

const { db, withBypassContext, withOrgContext } = await import(root + 'engine/src/platform/db.ts') as typeof import('../../../../../engine/src/platform/db.ts')
const { sql } = await import(root + 'node_modules/drizzle-orm/index.js') as typeof import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrgReporting } = await import(root + 'engine/src/testing/fixtures.ts')
// The loader, not the rendered tree: canReconcile is a loader-resolved
// boolean, so the loader output is the thing under test.
const { loadPspSettlements } = await import(root + 'web/app/(app)/banking/psp-settlements/view.ts')

async function seedPspPermsOrg(): Promise<{ org: ScratchOrg; actor: string }> {
  const org: ScratchOrg = await withBypassContext(() => createScratchOrg() as Promise<ScratchOrg>)
  const actor: string = await withBypassContext(() => createScratchUser(org.orgId, 'Psp operator', 'admin'))
  state.user = { id: actor, orgId: org.orgId, isSuperAdmin: false, name: 'Psp operator', email: 'psp@scratch.test',
    roles: [], envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor }
  return { org, actor }
}

async function setRolePermissions(orgId: string, permissions: string): Promise<void> {
  await withBypassContext(() => db.execute(sql`update app_roles set permissions=${permissions}::jsonb where org_id=${orgId} and key='admin'`))
}

// F1T-9: the import/post/reverse mutations POST with banking.reconcile, so
// the loader must resolve the grant for the page. A read-only operator
// still reads the batches; only the mutation affordance flag is false.
test('psp settlements resolve canReconcile from banking.reconcile', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org } = await seedPspPermsOrg()
  try {
    await setRolePermissions(org.orgId, '["banking.read"]')
    const readonly = (await withOrgContext(org.orgId, () => loadPspSettlements())) as {
      canReconcile: boolean
      rows: unknown[]
    }
    assert.equal(readonly.canReconcile, false)
    assert.ok(Array.isArray(readonly.rows), 'the read model still loads for read-only operators')
    await setRolePermissions(org.orgId, '["*"]')
    const full = (await withOrgContext(org.orgId, () => loadPspSettlements())) as { canReconcile: boolean }
    assert.equal(full.canReconcile, true)
  } finally {
    state.user = null
    await dropScratchOrgReporting(org.orgId)
  }
})
