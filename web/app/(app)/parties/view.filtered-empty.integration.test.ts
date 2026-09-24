import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import type { SessionUser } from '../../../lib/auth'

const root = pathToFileURL(process.cwd() + '/').href
const state: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __partiesFilteredEmptyUser: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === 'next-intl/server') {
      return virtual('export async function getTranslations(){return (key)=>key}; export async function getLocale(){return "en"}')
    }
    if ((specifier === './auth' || specifier.endsWith('/lib/auth')) && context.parentURL?.endsWith('/web/lib/authz.ts')) {
      return virtual('export async function currentUser(){return globalThis.__partiesFilteredEmptyUser.user}')
    }
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { loadParties, partiesSpec } = await import('./view')

const sessionFor = (orgId: string, actor: string): SessionUser => ({
  id: actor, orgId, name: 'Loader', email: 'loader@scratch.test',
  roles: [], isSuperAdmin: false, envKind: 'production',
  productionOrgId: orgId, homeOrgId: orgId, homeUserId: actor,
})

test('party filtering distinguishes a filtered-empty list from an empty directory', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  const reader = await withBypassContext(() => createScratchUser(org.orgId, 'Reader', 'reader'))
  try {
    await withBypassContext(() => db.execute(sql`
      update app_roles set permissions='["parties.read"]'::jsonb where org_id=${org.orgId} and key='reader'
    `))
    await withBypassContext(() => db.execute(sql`
      insert into parties (org_id, kind, display_name, is_active, custom)
      values (${org.orgId}, 'organization', 'Visible Supplier', true, '{}'::jsonb)
    `))
    state.user = sessionFor(org.orgId, reader)

    const unfiltered = await withOrgContext(org.orgId, () => loadParties({}))
    assert.equal(unfiltered.isEmpty, false)
    assert.equal(unfiltered.isFilteredEmpty, false)
    assert.equal(unfiltered.hasRows, true)

    const miss = await withOrgContext(org.orgId, () => loadParties({ q: 'zzz-no-such-party' }))
    assert.equal(miss.isEmpty, false, 'the party directory itself is not empty')
    assert.equal(miss.isFilteredEmpty, true)
    assert.equal(miss.hasRows, false, 'rows and pagination follow the filtered count')
    assert.equal(miss.total, 0)

    const blocks = (partiesSpec(miss) as unknown as {
      body?: { kind?: string; widget?: string; when?: { $?: string }; props?: { title?: string } }[]
    }).body ?? []
    assert.ok(blocks.some((block) =>
      block.widget === 'empty-state' && block.when?.$ === 'isFilteredEmpty' && block.props?.title === 'list.filteredEmptyTitle'))
    assert.ok(blocks.filter((block) => block.kind === 'table' || block.kind === 'pagination')
      .every((block) => block.when?.$ === 'hasRows'))
  } finally {
    state.user = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
