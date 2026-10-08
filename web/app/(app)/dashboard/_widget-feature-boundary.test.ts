import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { pathToFileURL } from 'node:url'
import { resolveAppModule } from '../../../lib/test-module-hooks'
import test from 'node:test'
import { canSeeWidget } from './_widget-access'
import { filterPersistableDashboardWidgets } from './_layout-input'
import type { Authz } from '@/lib/authz'

const root = pathToFileURL(process.cwd() + '/').href
const boundary = { enabled: false, features: [] as string[], metrics: [] as string[][], writes: [] as SQL[] }
Object.assign(globalThis, { __dashboardFeatureBoundary: boundary })
registerHooks({
  resolve(s, c, next) {
    const wrap = (path: string, source: string) => ({ shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(`export * from ${JSON.stringify(root + path)};${source}`) })
    if (s === 'next-intl/server') return { shortCircuit: true, url: 'data:text/javascript,export async function getLocale(){return "en"}export async function getTranslations(){return key=>key}' }
    if ((s === '@/lib/authz' || s === '../../lib/authz') && c.parentURL?.includes('/web/')) {
      return wrap('web/lib/authz.ts', 'export async function getAuthz(){return globalThis.__dashboardFeatureReader}')
    }
    if (s === '@/lib/features' && c.parentURL?.endsWith('/widget-features.ts')) {
      return wrap('web/lib/features.ts', `export async function isFeatureEnabled(orgId,key){const b=globalThis.__dashboardFeatureBoundary;b.features.push(key);return key !== 'resourcing' || b.enabled}`)
    }
    if (s.endsWith('/dashboard/_load-layout') || (s === './_load-layout' && c.parentURL?.endsWith('/dashboard/actions.ts'))) {
      return wrap('web/app/(app)/dashboard/_load-layout.ts', `
        export async function loadDashboardLayout(){return {layout:{widgets:[{id:'resourcing-pulse',x:0,y:0,w:3,h:2},{id:'kpi-journal-lines',x:3,y:0,w:3,h:2}]},role:'reader',hiddenQuickActionIds:[]}}
        export async function resolveDashboardDefault(){return {sourceKey:'reader'}}`)
    }
    if (s === './_metrics' && c.parentURL?.endsWith('/_edit-canvas.tsx')) {
      return wrap('web/app/(app)/dashboard/_metrics.ts', `export async function loadDashboardMetrics(authz,ids){globalThis.__dashboardFeatureBoundary.metrics.push(ids);return {}}`)
    }
    if (s === '@openbooks/engine/src/platform/db.ts' && c.parentURL?.endsWith('/dashboard/actions.ts')) {
      return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(`export const db={async transaction(fn){return fn({async execute(query){globalThis.__dashboardFeatureBoundary.writes.push(query);return {rows:[]}}})}}`) }
    }
    if (s === 'next/cache') return { shortCircuit: true, url: 'data:text/javascript,export function revalidatePath(){}' }
    return resolveAppModule(s, c, next, root) ?? next(s, c)
  },
})
const { resolveAllowedWidgetIds } = await import('./widget-features.ts')

/**
 * The resourcing feature boundary: a tile whose feature is off must be
 * pruned from existing layouts, absent from the add palette, and dropped by
 * the save filter — even when the caller holds its permission. With the
 * feature on and the grant held, the tile stays.
 *
 * Only the database-backed feature flag is stubbed (the seam the resolver
 * accepts as a parameter). Permission checks, the widget registry, and the
 * persistence filter are all real, so these properties fail if any boundary
 * falls back to the permission-only check.
 */
function fakeAuthz(permissions: string[]): Authz {
  return {
    user: { id: 'user-1', orgId: 'org-1', name: 'Test', email: 't@example.com', roles: [], envKind: 'production' },
    permissions: new Set(permissions),
    allowedSubsidiaryIds: null,
  } as unknown as Authz
}

const reader = fakeAuthz(['dashboard.read', 'gl.read', 'resourcing.read'])
Object.assign(globalThis, { __dashboardFeatureReader: reader })
const noGrant = fakeAuthz(['dashboard.read', 'gl.read'])
const featureOff = async (id: string) => id !== 'resourcing-pulse'
const featureOn = async (_id: string) => true

const tile = (id: string) => ({ id, x: 0, y: 0, w: 3, h: 2 })

// Finish loading every boundary before registering tests: the native runner
// exits after registered tests finish, including while a later import waits.
const { DashboardGridSlot } = await import('../../../components/viewspec/dashboard-grid-slot.tsx')
const { DashboardEditSlot } = await import('../../../components/viewspec/dashboard-edit-slot.tsx')
const { loadDashboardView, loadDashboardEditCanvas } = await import('./_edit-canvas.tsx')
const { saveDashboardLayout } = await import('./actions.ts')

test('feature-off prunes an existing pulse tile from the layout', async () => {
  // The defect, pinned: permission alone still sees the tile, so any
  // boundary using only canSeeWidget keeps the dead tile while Resourcing
  // is off.
  assert.equal(canSeeWidget(reader, 'resourcing-pulse'), true, 'resourcing.read passes the permission check alone')
  const allowed = await resolveAllowedWidgetIds(reader, featureOff)
  const visible = await loadDashboardView(reader, { widgets: [tile('resourcing-pulse'), tile('kpi-journal-lines')] }, allowed)
  assert.deepEqual(Object.keys(visible.nodes), ['kpi-journal-lines'], 'resourcing-pulse drops out while Resourcing is off')
})

test('feature-off keeps the pulse tile out of the addable set', async () => {
  const allowed = await resolveAllowedWidgetIds(reader, featureOff)
  assert.equal(allowed.has('resourcing-pulse'), false, 'resourcing-pulse is not offered while Resourcing is off')
  assert.equal(allowed.has('kpi-journal-lines'), true, 'an unrelated permitted tile stays addable')
})

test('feature-off save drops the pulse tile without touching the rest', async () => {
  const allowed = await resolveAllowedWidgetIds(reader, featureOff)
  const persisted = filterPersistableDashboardWidgets(
    [tile('resourcing-pulse'), tile('kpi-journal-lines')],
    { allowedWidgetIds: allowed, allowedAppWidgetIds: new Set(), allowAnyInsightCardUuid: false },
  )
  assert.deepEqual(
    persisted.map((w) => w.id),
    ['kpi-journal-lines'],
    'saving a layout with a feature-off tile persists everything except that tile',
  )
})

test('feature-on plus resourcing.read preserves the pulse tile', async () => {
  const allowed = await resolveAllowedWidgetIds(reader, featureOn)
  assert.equal(allowed.has('resourcing-pulse'), true, 'resourcing-pulse stays when Resourcing is on and granted')
})

test('missing permission refuses the pulse tile even with the feature on', async () => {
  const allowed = await resolveAllowedWidgetIds(noGrant, featureOn)
  assert.equal(allowed.has('resourcing-pulse'), false, 'resourcing-pulse stays hidden without resourcing.read')
})

// Only session/storage/feature I/O is replaced. Both slots, both canvas
// loaders, the resolver, and the save action execute their real decisions.

test('the view slot resolves once and excludes disabled nodes and metric reads', async () => {
  for (const enabled of [false, true]) {
    Object.assign(boundary, { enabled, features: [], metrics: [] })
    const result = await DashboardGridSlot()
    assert.ok(result)
    assert.equal(result.props.initialLayout.widgets.some((w: { id: string }) => w.id === 'resourcing-pulse'), enabled)
    assert.equal(Object.hasOwn(result.props.nodes, 'resourcing-pulse'), enabled)
    assert.equal(boundary.metrics.flat().includes('resourcing-pulse'), enabled)
    assert.equal(boundary.features.filter((key) => key === 'resourcing').length, 1)
    assert.ok(result.props.nodes['kpi-journal-lines'])
  }
})

test('the edit slot keeps layout, palette, nodes and metric reads on one feature decision', async () => {
  for (const enabled of [false, true]) {
    Object.assign(boundary, { enabled, features: [], metrics: [] })
    const result = await DashboardEditSlot()
    assert.ok(result)
    assert.equal(result.props.initialLayout.widgets.some((w: { id: string }) => w.id === 'resourcing-pulse'), enabled)
    assert.equal(result.props.allowedWidgetIds.includes('resourcing-pulse'), enabled)
    assert.equal(Object.hasOwn(result.props.nodes, 'resourcing-pulse'), enabled)
    assert.equal(boundary.metrics.flat().includes('resourcing-pulse'), enabled)
    assert.equal(boundary.features.filter((key) => key === 'resourcing').length, 1)
  }
})

test('both canvas loaders obey the supplied set without querying features', async () => {
  Object.assign(boundary, { enabled: true, features: [], metrics: [] })
  const layout = { widgets: [tile('resourcing-pulse'), tile('kpi-journal-lines')] }
  const allowed = new Set(['kpi-journal-lines'])
  for (const result of [await loadDashboardView(reader, layout, allowed), await loadDashboardEditCanvas(reader, layout, { allowedWidgetIds: allowed })]) {
    assert.deepEqual(Object.keys(result.nodes), ['kpi-journal-lines'])
  }
  assert.deepEqual(boundary.metrics, [['kpi-journal-lines'], ['kpi-journal-lines']])
  assert.deepEqual(boundary.features, [])
})

test('the save action persists only widgets allowed by the feature decision', async () => {
  for (const enabled of [false, true]) {
    Object.assign(boundary, { enabled, features: [], writes: [] })
    assert.deepEqual(await saveDashboardLayout({ widgets: [tile('resourcing-pulse'), tile('kpi-journal-lines')] }), { ok: true })
    assert.equal(boundary.writes.length, 3)
    const query = new PgDialect().sqlToQuery(boundary.writes[2]!)
    const layouts = query.params.filter((param): param is string => typeof param === 'string' && param.startsWith('{"widgets":'))
    assert.equal(layouts.length, 2, 'insert and conflict-update carry the same filtered layout')
    for (const serialized of layouts) {
      assert.deepEqual(JSON.parse(serialized).widgets.map((w: { id: string }) => w.id), enabled ? ['resourcing-pulse', 'kpi-journal-lines'] : ['kpi-journal-lines'])
    }
    assert.equal(boundary.features.filter((key) => key === 'resourcing').length, 1)
  }
})
