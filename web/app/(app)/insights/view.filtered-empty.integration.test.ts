import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import type { SessionUser } from '../../../lib/auth'

/**
 * Filtered-empty library contract (F4T-7).
 *
 * A search/status filter that matches nothing is not an empty library: the
 * loader reports `isFilteredEmpty` (library non-empty, filtered set empty),
 * `hasRows` follows the FILTERED total, and the spec renders the
 * filtered-empty state instead of a blank grid. Only session copy and
 * translations are doubled; the loader runs REAL against scratch orgs.
 */
const root = pathToFileURL(process.cwd() + '/').href
const state: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __insightsFilteredEmptyUser: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === 'next-intl/server') {
      return virtual('export async function getTranslations(){return (key)=>key}; export async function getLocale(){return "en"}')
    }
    if ((specifier === './auth' || specifier.endsWith('/lib/auth')) && context.parentURL?.endsWith('/web/lib/authz.ts')) {
      return virtual('export async function currentUser(){return globalThis.__insightsFilteredEmptyUser.user}')
    }
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { loadInsights, insightsSpec } = await import('./view')

const sessionFor = (orgId: string, actor: string): SessionUser => ({
  id: actor, orgId, name: 'Loader', email: 'loader@scratch.test',
  roles: [], isSuperAdmin: false, envKind: 'production',
  productionOrgId: orgId, homeOrgId: orgId, homeUserId: actor,
})

async function setupOrgWithCard() {
  const org = await withBypassContext(() => createScratchOrg())
  const reader = await withBypassContext(() => createScratchUser(org.orgId, 'Reader', 'reader'))
  await withBypassContext(() =>
    db.execute(sql`update app_roles set permissions='["insights.read"]'::jsonb where org_id=${org.orgId} and key='reader'`),
  )
  await withBypassContext(() =>
    db.execute(sql`insert into insight_cards (org_id, name, query, viz_type, status, allowed_roles, created_by, updated_by)
      values (${org.orgId}, 'Revenue trend', '{"source":"ledger_lines"}', 'bar', 'published', null, ${reader}, ${reader})`),
  )
  return { org, reader }
}

test('a filter that matches nothing reports filtered-empty, not an empty library', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org, reader } = await setupOrgWithCard()
  try {
    state.user = sessionFor(org.orgId, reader)
    const unfiltered = await withOrgContext(org.orgId, () => loadInsights({}))
    assert.equal(unfiltered.isEmpty, false)
    assert.equal(unfiltered.isFilteredEmpty, false)
    assert.equal(unfiltered.hasRows, true)

    const miss = await withOrgContext(org.orgId, () => loadInsights({ q: 'zzz-no-such-card' }))
    assert.equal(miss.isEmpty, false, 'the library itself is not empty')
    assert.equal(miss.isFilteredEmpty, true)
    assert.equal(miss.hasRows, false, 'the grid and pagination follow the filtered total')
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('the spec renders the filtered-empty state and hides the grid', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org, reader } = await setupOrgWithCard()
  try {
    state.user = sessionFor(org.orgId, reader)
    const miss = await withOrgContext(org.orgId, () => loadInsights({ q: 'zzz-no-such-card' }))
    const spec = insightsSpec(miss)
    // insightsSpec returns page({ header, body }): the states and the grid
    // live in the body block list.
    const blocks = (
      spec as unknown as {
        body?: { kind?: string; widget?: string; when?: { $?: string }; props?: { title?: string } }[]
      }
    ).body ?? []
    const emptyStates = blocks.filter((b) => b.kind === 'widget' && b.widget === 'empty-state')
    assert.ok(
      emptyStates.some((b) => b.when?.$ === 'isFilteredEmpty' && b.props?.title === 'cards.filterEmptyTitle'),
      'a filtered-empty block names the filters',
    )
    const grids = blocks.filter((b) => b.kind === 'table' || b.kind === 'pagination')
    assert.ok(grids.length > 0, 'the grid blocks exist')
    assert.ok(
      grids.every((b) => b.when?.$ === 'hasRows'),
      'the table and pagination only render on rows',
    )
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('a genuinely empty library still reports isEmpty', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  const reader = await withBypassContext(() => createScratchUser(org.orgId, 'Reader', 'reader'))
  await withBypassContext(() =>
    db.execute(sql`update app_roles set permissions='["insights.read"]'::jsonb where org_id=${org.orgId} and key='reader'`),
  )
  try {
    state.user = sessionFor(org.orgId, reader)
    const data = await withOrgContext(org.orgId, () => loadInsights({}))
    assert.equal(data.isEmpty, true)
    assert.equal(data.isFilteredEmpty, false)
    assert.equal(data.hasRows, false)
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
