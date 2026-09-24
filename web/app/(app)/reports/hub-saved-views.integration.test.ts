import { registerHooks } from 'node:module'
import { resolveAppModule } from '../../../lib/test-module-hooks'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import * as React from 'react'
import type { ScratchOrg } from '../../../../engine/src/testing/fixtures.ts'
const repo = process.cwd()
const root = pathToFileURL(repo + '/').href
const state: { user: import('../../../lib/auth').SessionUser | null } = { user: null }
Object.assign(globalThis, { __hubSavedViewsState: state, React })
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
          `export * from ${JSON.stringify(root + 'web/lib/auth.ts')};export async function currentUser(){return globalThis.__hubSavedViewsState.user;}`,
        ),
      }
    }
    const app = resolveAppModule(s, c, next, root)
    if (app) return app
    return next(s, c)
  },
})

const { db, withBypassContext, withOrgContext } = await import(root + 'engine/src/platform/db.ts') as typeof import('../../../../engine/src/platform/db.ts')
const { sql } = await import(root + 'node_modules/drizzle-orm/index.js') as typeof import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrgReporting } = await import(root + 'engine/src/testing/fixtures.ts')
// The loader, not the rendered tree: saved-view visibility is loader-resolved
// data, so the loader output is the thing under test.
const { loadReportsHub } = await import(root + 'web/app/(app)/reports/view.ts')

type HubData = {
  groups: Array<{ key: string; cards: Array<{ href: string; title: string }> }>
}

function customHrefs(data: HubData): string[] {
  const custom = data.groups.find((g) => g.key === 'custom')
  assert.ok(custom, 'the hub keeps its Custom & Saved group')
  return custom.cards.map((c) => c.href)
}

// Seeds run under the explicit bypass: unscoped writes would silently match
// zero rows under pooled RLS (the allocations tabs-test rot).
async function seedHubOrg(projectsOn: boolean): Promise<{ org: ScratchOrg }> {
  const org: ScratchOrg = await withBypassContext(() => createScratchOrg() as Promise<ScratchOrg>)
  await withBypassContext(async () => {
    const actor: string = await createScratchUser(org.orgId, 'Hub reader', 'admin')
    await db.execute(sql`update app_roles set permissions='["reports.read"]'::jsonb where org_id=${org.orgId} and key='admin'`)
    if (!projectsOn) {
      await db.execute(sql`update orgs set settings = coalesce(settings, '{}'::jsonb)
        || jsonb_build_object('features', coalesce(settings->'features', '{}'::jsonb) || '{"projects": false}'::jsonb)
        where id = ${org.orgId}`)
    }
    await db.execute(sql`insert into saved_reports(org_id, name, path, params, created_by)
      values (${org.orgId}, 'True cost HL', '/reports/true-cost', '{}', ${actor}),
             (${org.orgId}, 'P&L HL', '/reports/pnl', '{}', ${actor})`)
    state.user = { id: actor, orgId: org.orgId, isSuperAdmin: false, name: 'Hub reader', email: 'hub@scratch.test',
      roles: [], envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor }
  })
  return { org }
}

// F1T-16: a saved /reports/true-cost view showed with Projects off because
// the hub filtered saved views from a hand list that omitted true-cost. The
// filter now derives from the route-gate registry.
test('saved true-cost view hides with Projects off', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org } = await seedHubOrg(false)
  try {
    const data = (await withOrgContext(org.orgId, () => loadReportsHub())) as HubData
    const hrefs = customHrefs(data)
    assert.ok(hrefs.includes('/reports/pnl'), `ungated saved view must list, got ${JSON.stringify(hrefs)}`)
    assert.ok(!hrefs.includes('/reports/true-cost'), `gated saved view must hide with Projects off, got ${JSON.stringify(hrefs)}`)
  } finally {
    state.user = null
    await dropScratchOrgReporting(org.orgId)
  }
})

test('saved true-cost view lists with Projects on', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org } = await seedHubOrg(true)
  try {
    const data = (await withOrgContext(org.orgId, () => loadReportsHub())) as HubData
    const hrefs = customHrefs(data)
    assert.ok(hrefs.includes('/reports/true-cost'), `gated saved view must list with Projects on, got ${JSON.stringify(hrefs)}`)
    assert.ok(hrefs.includes('/reports/pnl'), `ungated saved view must list, got ${JSON.stringify(hrefs)}`)
  } finally {
    state.user = null
    await dropScratchOrgReporting(org.orgId)
  }
})
