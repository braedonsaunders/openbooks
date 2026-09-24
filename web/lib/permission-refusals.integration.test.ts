import { registerHooks } from 'node:module'
import { resolveAppModule } from './test-module-hooks'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import * as React from 'react'
import type { ScratchOrg } from '../../engine/src/testing/fixtures.ts'
const repo = process.cwd()
const root = pathToFileURL(repo + '/').href
const state: { user: import('./auth').SessionUser | null } = { user: null }
Object.assign(globalThis, { __refusalsState: state, React })
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
          `export * from ${JSON.stringify(root + 'web/lib/auth.ts')};export async function currentUser(){return globalThis.__refusalsState.user;}`,
        ),
      }
    }
    const app = resolveAppModule(s, c, next, root)
    if (app) return app
    return next(s, c)
  },
})

const { db, withBypassContext, withOrgContext } = await import(root + 'engine/src/platform/db.ts') as typeof import('../../engine/src/platform/db.ts')
const { sql } = await import(root + 'node_modules/drizzle-orm/index.js') as typeof import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrgReporting } = await import(root + 'engine/src/testing/fixtures.ts')
// The loaders (plus the setup shell), not rendered trees: each refusal is a
// loader-resolved redirect, so the thrown NEXT_REDIRECT digest is the thing
// under test. Real authz, real navigation — only identity is scripted.
const { loadPspSettlements } = await import(root + 'web/app/(app)/banking/psp-settlements/view.ts')
const { loadWizard } = await import(root + 'web/app/(app)/admin/setup/wizard/view.ts')
const { loadAllocations } = await import(root + 'web/app/(app)/admin/setup/allocations/view.ts')
const { loadNavigationAdmin } = await import(root + 'web/app/(app)/admin/navigation/view.ts')
const { loadSentinel } = await import(root + 'web/app/(app)/analytics/sentinel/view.ts')
const { loadAudit } = await import(root + 'web/app/(app)/admin/audit/view.ts')
const { loadTax } = await import(root + 'web/app/(app)/tax/view.ts')
const { loadAdminHub } = await import(root + 'web/app/(app)/admin/view.ts')
const { loadBuildHub } = await import(root + 'web/app/(app)/admin/build/view.ts')
const SetupLayout = (await import(root + 'web/app/(app)/admin/setup/layout.tsx')).default as (props: {
  children: React.ReactNode
}) => Promise<unknown>

/** Run a loader and return the redirect it refused with. A refusal that is
 * computed must be raised: anything else (a render, a bounce home, a 404)
 * fails the digest match below. */
async function refusalDigest(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
  } catch (error) {
    const digest = (error as { digest?: string }).digest ?? ''
    assert.match(digest, /^NEXT_REDIRECT/, `expected a redirect refusal, got ${JSON.stringify(String(error).slice(0, 200))}`)
    assert.ok(!digest.includes(';replace;/;') && !digest.includes(';replace;/dashboard;'), `refusal must not bounce home silently, got ${digest}`)
    return digest
  }
  throw new Error('the loader rendered instead of refusing')
}

async function seedRefusalOrg(
  permissions: string[],
  subsidiaryId: string | null = null,
): Promise<{ org: ScratchOrg }> {
  const org: ScratchOrg = await withBypassContext(() => createScratchOrg() as Promise<ScratchOrg>)
  await withBypassContext(async () => {
    const actor: string = await createScratchUser(org.orgId, 'Refused operator', 'admin')
    await db.execute(sql`update app_roles set permissions=${JSON.stringify(permissions)}::jsonb where org_id=${org.orgId} and key='admin'`)
    if (subsidiaryId !== null) {
      await db.execute(sql`update app_roles set subsidiary_restriction=${JSON.stringify({ mode: 'list', subsidiaryIds: [subsidiaryId] })}::jsonb where org_id=${org.orgId} and key='admin'`)
    }
    state.user = { id: actor, orgId: org.orgId, isSuperAdmin: false, name: 'Refused operator', email: 'refused@scratch.test',
      roles: [], envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor }
  })
  return { org }
}

async function teardown(org: ScratchOrg): Promise<void> {
  state.user = null
  await dropScratchOrgReporting(org.orgId)
}

// F1T-10: a banking-feature user without banking.read met a silent bounce
// home; the house refusal names banking.read.
test('psp settlements without banking.read name the refusal', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org } = await seedRefusalOrg([])
  try {
    const digest = await refusalDigest(() => withOrgContext(org.orgId, () => loadPspSettlements()))
    assert.ok(digest.includes('/access-denied?permission=banking.read'), `refusal must name banking.read, got ${digest}`)
  } finally {
    await teardown(org)
  }
})

test('setup wizard without admin.setup.manage names the refusal', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org } = await seedRefusalOrg([])
  try {
    const digest = await refusalDigest(() => withOrgContext(org.orgId, () => loadWizard()))
    assert.ok(digest.includes('/access-denied?permission=admin.setup.manage'), `refusal must name admin.setup.manage, got ${digest}`)
  } finally {
    await teardown(org)
  }
})

test('allocations setup without either setup grant names the refusal', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org } = await seedRefusalOrg([])
  try {
    const digest = await refusalDigest(() => withOrgContext(org.orgId, () => loadAllocations({})))
    assert.ok(digest.includes('/access-denied?permission=admin.setup.manage'), `refusal must name admin.setup.manage, got ${digest}`)
  } finally {
    await teardown(org)
  }
})

test('setup shell without either setup grant names the refusal', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org } = await seedRefusalOrg([])
  try {
    const digest = await refusalDigest(() => withOrgContext(org.orgId, () => SetupLayout({ children: null })))
    assert.ok(digest.includes('/access-denied?permission=admin.setup.manage'), `refusal must name admin.setup.manage, got ${digest}`)
  } finally {
    await teardown(org)
  }
})

test('navigation admin without either nav grant names the refusal', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org } = await seedRefusalOrg([])
  try {
    const digest = await refusalDigest(() => withOrgContext(org.orgId, () => loadNavigationAdmin()))
    assert.ok(digest.includes('/access-denied?permission=admin.nav.manage'), `refusal must name admin.nav.manage, got ${digest}`)
  } finally {
    await teardown(org)
  }
})

test('sentinel without admin.audit.read names the refusal', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org } = await seedRefusalOrg(['reports.read'])
  try {
    const digest = await refusalDigest(() => withOrgContext(org.orgId, () => loadSentinel({})))
    assert.ok(digest.includes('/access-denied?permission=admin.audit.read'), `refusal must name admin.audit.read, got ${digest}`)
  } finally {
    await teardown(org)
  }
})

test('hub landings without any hub permission name the hub and its keys', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org } = await seedRefusalOrg([])
  try {
    // The key set is DERIVED from the same GROUPS source the hub filters,
    // so the test asserts derivation members, never a hand list: removing a
    // card permission from the hub must also remove it from the refusal.
    const admin = await refusalDigest(() => withOrgContext(org.orgId, () => loadAdminHub()))
    assert.ok(admin.includes('/access-denied?permission='), `admin hub must name its refusal, got ${admin}`)
    assert.ok(admin.includes('admin.users.manage'), `admin refusal must derive the hub keys, got ${admin}`)
    assert.ok(admin.includes('admin.audit.read'), `admin refusal must derive the hub keys, got ${admin}`)
    const build = await refusalDigest(() => withOrgContext(org.orgId, () => loadBuildHub()))
    assert.ok(build.includes('/access-denied?permission='), `build hub must name its refusal, got ${build}`)
    assert.ok(build.includes('apps.manage'), `build refusal must derive the hub keys, got ${build}`)
  } finally {
    await teardown(org)
  }
})

test('whole-company surfaces refuse restricted callers by name', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org } = await seedRefusalOrg(['reports.read', 'admin.audit.read'], 'SUBSIDIARY')
  try {
    // The scratch subsidiary stands in for any entity outside the caller's
    // grants; the loaders only test restricted-vs-not.
    const sentinel = await refusalDigest(() => withOrgContext(org.orgId, () => loadSentinel({})))
    assert.ok(sentinel.includes('/access-denied?permission='), `sentinel must name its refusal, got ${sentinel}`)
    const audit = await refusalDigest(() => withOrgContext(org.orgId, () => loadAudit({})))
    assert.ok(audit.includes('/access-denied?permission='), `audit must name its refusal, got ${audit}`)
    const tax = await refusalDigest(() => withOrgContext(org.orgId, () => loadTax({})))
    assert.ok(tax.includes('/access-denied?permission='), `tax must name its refusal, got ${tax}`)
  } finally {
    await teardown(org)
  }
})
