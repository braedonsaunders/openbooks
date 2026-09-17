import { registerHooks } from 'node:module'
import { resolveAppModule } from './test-module-hooks'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * F-t01-017 — the readiness go-live guide rendered fully English in fr/es
 * because the loader hardcoded its whole body. The loader now resolves every
 * user-facing string through `admin.setup.guide`.
 *
 * This test runs the real loader against a scratch org with a key-echo
 * translator and asserts every emitted copy string is a guide key lookup —
 * no hardcoded English can survive here without failing.
 */
const repo = process.cwd()
const root = pathToFileURL(repo + '/').href
const state: { user: import('./auth').SessionUser | null } = { user: null }
registerHooks({
  resolve(s, c, next) {
    if (s === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    if (s === 'next-intl/server') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,' + encodeURIComponent(
          'export async function getTranslations(){const t=(key)=>`t:${key}`;return t;};export async function getLocale(){return "en"}',
        ),
      }
    }
    if ((s === './auth' || s.endsWith('/lib/auth')) && c.parentURL?.includes('/web/') && !c.parentURL.includes('/web/lib/auth.ts')) {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,' + encodeURIComponent(
          `export * from ${JSON.stringify(root + 'web/lib/auth.ts')};export async function currentUser(){return globalThis.__readinessGuideState.user;}`,
        ),
      }
    }
    const app = resolveAppModule(s, c, next, root)
    if (app) return app
    return next(s, c)
  },
})
Object.assign(globalThis, { __readinessGuideState: state })

const { db, withBypassContext, withOrgContext } = (await import(root + 'engine/src/db.ts')) as typeof import('@openbooks/engine/src/db.ts')
const { sql } = await import(root + 'node_modules/drizzle-orm/index.js')
const { createScratchOrg, createScratchUser, dropScratchOrg } = (await import(root + 'engine/src/test-fixtures.ts')) as typeof import('@openbooks/engine/src/test-fixtures.ts')
const { loadSetupReadiness } = (await import(root + 'web/app/(app)/admin/setup/readiness/view.ts')) as typeof import('../app/(app)/admin/setup/readiness/view')

test('readiness guide copy resolves through admin.setup.guide, never hardcoded', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Guide operator', 'admin'))
    await withBypassContext(() => db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`))
    state.user = { id: actor, orgId: org.orgId, isSuperAdmin: false, name: 'Guide operator', email: 'guide@scratch.test',
      roles: [], envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor }
    const data = await withOrgContext(org.orgId, () => loadSetupReadiness())
    assert.equal(data.checks.length, 7, 'seven guide areas')
    const echoed: string[] = [
      data.hero.kicker, data.hero.title, data.hero.description,
      data.hero.badgeLabel, data.hero.progressLabel, data.hero.progressOf,
    ]
    for (const check of data.checks) {
      echoed.push(check.title, check.description, check.action, check.stateLabel)
    }
    assert.equal(echoed.length, 6 + 7 * 4)
    for (const copy of echoed) {
      assert.match(copy, /^t:setup\.guide\./, `guide copy must be a catalog lookup, got ${JSON.stringify(copy)}`)
    }
  } finally {
    state.user = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
