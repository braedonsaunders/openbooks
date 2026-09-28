import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { canSeeWidget } from './_widget-access'
import { WIDGETS } from './_widget-registry'
import { filterPersistableDashboardWidgets } from './_layout-input'
import type { Authz } from '@/lib/authz'

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
const noGrant = fakeAuthz(['dashboard.read', 'gl.read'])
const featureOff = async (id: string) => id !== 'resourcing-pulse'
const featureOn = async (_id: string) => true

const tile = (id: string) => ({ id, x: 0, y: 0, w: 3, h: 2 })

/** The exact filter both slots apply: registry ids through the resolved set. */
function slotFilter(authz: Authz, allowed: ReadonlySet<string>, ids: string[]): string[] {
  return ids.filter((id) => (id in WIDGETS ? allowed.has(id) : canSeeWidget(authz, id)))
}

test('feature-off prunes an existing pulse tile from the layout', async () => {
  // The defect, pinned: permission alone still sees the tile, so any
  // boundary using only canSeeWidget keeps the dead tile while Resourcing
  // is off.
  assert.equal(canSeeWidget(reader, 'resourcing-pulse'), true, 'resourcing.read passes the permission check alone')
  const allowed = await resolveAllowedWidgetIds(reader, featureOff)
  const visible = slotFilter(reader, allowed, ['resourcing-pulse', 'kpi-journal-lines', 'personal-actions'])
  assert.deepEqual(visible, ['kpi-journal-lines', 'personal-actions'], 'resourcing-pulse drops out while Resourcing is off')
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

/**
 * Real-boundary proof, in the house source-reading style: the resolver
 * properties above would stay green if a slot or the save action went blind
 * and rebuilt a permission-only set by hand. These assertions tie each
 * server boundary to the single resolver and the required allowed set, so a
 * boundary that stops consuming it fails here.
 */
const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')

const gridSlot = read('../../../components/viewspec/dashboard-grid-slot.tsx')
const editSlot = read('../../../components/viewspec/dashboard-edit-slot.tsx')
const canvas = read('./_edit-canvas.tsx')
const actionsSource = read('./actions.ts')

test('the view slot resolves once and hands the set to the canvas loader', () => {
  assert.ok(gridSlot.includes('await resolveAllowedWidgetIds(authz)'), 'view slot resolves the allowed set')
  assert.ok(
    gridSlot.includes('loadDashboardView(authz, visibleLayout, allowedWidgetIds)'),
    'view slot passes that same set into the canvas loader',
  )
  assert.equal(gridSlot.includes('new Set(Object.keys(WIDGETS)'), false, 'view slot builds no parallel permission-only set')
})

test('the edit slot drives layout, palette, and canvas from one set', () => {
  assert.ok(editSlot.includes('await resolveAllowedWidgetIds(authz)'), 'edit slot resolves the allowed set')
  assert.ok(
    editSlot.includes('loadDashboardEditCanvas(authz, visibleLayout, {'),
    'edit slot passes the set into the edit canvas loader',
  )
  assert.equal(editSlot.includes('new Set(Object.keys(WIDGETS)'), false, 'edit slot builds no parallel permission-only set')
})

test('both canvas loaders require the set and never resolve features', () => {
  const required = canvas.match(/allowedWidgetIds: AllowedWidgetIds/g) ?? []
  assert.equal(required.length >= 2, true, 'view and edit canvas loaders both declare the required allowed set')
  assert.equal(canvas.includes('resolveAllowedWidgetIds'), false, 'the canvas never resolves the set itself')
  assert.equal(canvas.includes('widgetFeatureOn'), false, 'the canvas holds no second feature check')
  assert.equal(canvas.includes('allowedWidgetIds?'), false, 'the canvas takes no optional allowed set')
  assert.equal(canvas.includes('!opts.allowedWidgetIds'), false, 'the canvas has no fail-open registry path')
})

test('the save action persists through the resolved set', () => {
  assert.ok(actionsSource.includes('await resolveAllowedWidgetIds(authz)'), 'save resolves the allowed set')
  assert.ok(actionsSource.includes('allowedWidgetIds,'), 'save feeds that set into the persistence filter')
  assert.equal(actionsSource.includes('canSeeWidget'), false, 'save keeps no permission-only registry path')
})
