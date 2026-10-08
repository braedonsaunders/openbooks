import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const state = { denied: false, reads: 0, stored: [] as Record<string, unknown>[] }
Object.assign(globalThis, { __pageLayoutsBoundary: state })
const boundaries = new Map([
  [new URL('../../../../lib/authz.ts', import.meta.url).href, `
    export async function requirePermission(permission) {
      if (permission !== 'admin.customization.manage') throw new Error('Unexpected permission');
      if (globalThis.__pageLayoutsBoundary.denied) throw new Error('Forbidden');
      return { user: { orgId: 'org-a', id: 'user-a' } };
    }
  `],
  [new URL('../../../../lib/page-specs.ts', import.meta.url).href, `
    export async function listPageSpecs(org, user) {
      if (org !== 'org-a' || user !== 'user-a') throw new Error('Unexpected layout identity');
      globalThis.__pageLayoutsBoundary.reads++;
      return globalThis.__pageLayoutsBoundary.stored;
    }
    export async function loadPageSpec() { throw new Error('Unexpected drawer read'); }
  `],
])
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next-intl/server') return {
      shortCircuit: true,
      url: 'data:text/javascript,export async function getTranslations(){return (key)=>key}',
    }
    const resolved = next(specifier, context)
    const boundary = boundaries.get(resolved.url)
    return boundary === undefined ? resolved : {
      shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(boundary),
    }
  },
})
const { loadPageLayouts, pageLayoutsSpec } = await import('./view.ts')
const { PAGE_ROUTES } = await import('../../../../lib/page-registry.ts')
const { preparedListSource, preparedPageState } = await import('../../../../lib/list/prepared-sources.ts')
hooks.deregister()

test('layout pagination exposes every registered route through bounded server windows', async () => {
  state.denied = false
  state.stored = []
  const seen: string[] = []
  for (let page = 1; page <= Math.ceil(PAGE_ROUTES.length / 25); page++) {
    const data = await loadPageLayouts({ page: String(page) })
    assert.ok(data.rows.length <= 25)
    assert.equal(data.total, PAGE_ROUTES.length)
    assert.deepEqual(preparedPageState(preparedListSource('admin_page_layouts'), data), {
      total: PAGE_ROUTES.length, page, perPage: 25,
    })
    seen.push(...data.rows.map((row) => row.route))
    assert.ok(pageLayoutsSpec(data).body.some((block) => block.kind === 'pagination'))
  }
  assert.deepEqual(seen, PAGE_ROUTES)
  const stale = await loadPageLayouts({ page: '10000' })
  assert.deepEqual(stale.rows, [])
  assert.equal(stale.total, PAGE_ROUTES.length)
})

test('layout search and status cover the full registry before pagination and preserve drawer return state', async () => {
  state.stored = PAGE_ROUTES.slice(-8).map((route, index) => ({
    route, userId: index % 2 ? 'user-a' : null, updatedAt: '2026-10-01', note: 'Saved layout',
  }))
  const params = { status: 'customized', page: '2', perPage: '5' }
  const data = await loadPageLayouts(params)
  assert.equal(data.total, 8)
  assert.deepEqual(data.rows.map((row) => row.route), PAGE_ROUTES.slice(-3))
  assert.equal(data.rows[0]!.statusLabel, 'status.personal')
  const href = new URL(data.rows[0]!.href, 'https://openbooks.test')
  assert.equal(href.searchParams.get('page'), '2')
  assert.equal(href.searchParams.get('status'), 'customized')
  assert.equal(href.searchParams.get('route'), data.rows[0]!.route)
  assert.equal(href.searchParams.get('drawerReturn'), '/admin/page-layouts?status=customized&page=2&perPage=5')
  const target = PAGE_ROUTES.at(-1)!
  const found = await loadPageLayouts({ q: target, status: 'customized', route: '/unknown-route' })
  assert.ok(found.rows.some((row) => row.route === target))
  assert.equal(found.drawerOpen, false)
  assert.equal(found.drawer, null)
})

test('layout permission refusal happens before stored layout reads', async () => {
  state.denied = true
  const before = state.reads
  await assert.rejects(loadPageLayouts({}), /Forbidden/)
  assert.equal(state.reads, before)
  state.denied = false
})
