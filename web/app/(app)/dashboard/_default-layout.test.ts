import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_DASHBOARD_LAYOUTS, DASHBOARD_ROLE_KEYS } from '@openbooks/schema'
import { INDUSTRIES } from '@/lib/industries'
import { TEAM_SIZES, COMPLEXITY_LEVELS } from '@/lib/workspace-profile'
import { financialDefaultLayout, isShippedRoleLayout } from './_workspace-layout'
import { packDefaultLayout, selectStoredDashboardLayout } from './_default-layout'
import { clampToWidgetMinimums, DashboardLayoutInputSchema } from './_layout-input'
import { hasFinancialWorkspace } from './_widget-access'
import type { Authz } from '@/lib/authz'

test('every industry, company size, complexity and financial role packs visible defaults into valid consecutive rows', () => {
  for (const industry of INDUSTRIES) for (const teamSize of TEAM_SIZES) for (const complexity of COMPLEXITY_LEVELS) for (const role of DASHBOARD_ROLE_KEYS) {
    const source = financialDefaultLayout(role, { industryCategory: industry.category, teamSize, complexity })
    const snapshot = structuredClone(source)
    // Feature/permission pruning must remove space as well as the widget.
    const layout = packDefaultLayout({ ...source, widgets: source.widgets.filter((_, index) => index % 3 !== 1) })
    const label = `${industry.key}/${teamSize}/${complexity}/${role}`
    assert.ok(DashboardLayoutInputSchema.safeParse(layout).success, label)
    assert.deepEqual(clampToWidgetMinimums(layout.widgets), layout.widgets, label)
    assert.deepEqual(source, snapshot, `${label}: source is immutable`)
    assert.equal(new Set(layout.widgets.map((cell) => cell.id)).size, layout.widgets.length, label)
    let end = 0
    for (const y of [...new Set(layout.widgets.map((cell) => cell.y))]) {
      const row = layout.widgets.filter((cell) => cell.y === y)
      assert.equal(y, end, `${label}: no reserved empty rows`)
      let x = 0
      for (const cell of row) {
        assert.equal(cell.x, x, `${label}: consecutive columns`)
        x += cell.w
      }
      assert.ok(x <= 12, `${label}: fits the grid`)
      end += Math.max(...row.map((cell) => cell.h))
    }
  }
})

test('only unchanged seeded role templates follow product defaults; edited layouts remain tenant-owned', () => {
  const manager: Authz = {
    user: {
      id: 'manager', email: 'manager@example.test', name: 'People manager',
      roles: [{ key: 'people_manager', name: 'People manager' }],
      orgId: 'organization', envKind: 'sandbox', productionOrgId: 'organization',
      isSuperAdmin: false, homeUserId: 'manager', homeOrgId: 'organization',
    },
    permissions: new Set(['reports.read', 'hrm.team.read']),
    allowedSubsidiaryIds: null,
  }
  assert.equal(hasFinancialWorkspace(manager), false, 'general reports do not displace a people workspace')
  assert.ok(hasFinancialWorkspace({ ...manager, permissions: new Set(['gl.read']) }), 'ledger readers receive the financial workspace')
  // Grants, never role names: an admin role key with only general reports
  // confers nothing, while a payables approver qualifies by grant alone.
  assert.equal(
    hasFinancialWorkspace({ ...manager, user: { ...manager.user, roles: [{ key: 'admin', name: 'Admin' }] } }),
    false,
    'role names never confer the financial workspace',
  )
  assert.ok(
    hasFinancialWorkspace({ ...manager, permissions: new Set(['ap.approve']) }),
    'payables approvers receive the financial workspace by grant',
  )
  const seed = structuredClone(DEFAULT_DASHBOARD_LAYOUTS.admin)
  assert.ok(isShippedRoleLayout('admin', seed))
  seed.widgets[0]!.w = 4
  assert.equal(isShippedRoleLayout('admin', seed), false)
  assert.equal(isShippedRoleLayout('admin', { ...DEFAULT_DASHBOARD_LAYOUTS.admin, quickActions: [] }), false)
  const fallback = { layout: financialDefaultLayout('admin', { complexity: 'essentials', teamSize: 'solo' }), isSystemDefault: true }
  const customised = selectStoredDashboardLayout(fallback, { layout: seed, is_customised: true })
  assert.deepEqual(customised.layout, seed, 'customized coordinates survive default changes')
  assert.equal(customised.isSystemDefault, false, 'customized layouts must not be repacked')
  assert.deepEqual(selectStoredDashboardLayout(fallback, { layout: seed, is_customised: false }).layout, fallback.layout, 'same-source snapshots receive fresh defaults')
  assert.deepEqual(selectStoredDashboardLayout({ layout: seed, isSystemDefault: false }).layout, seed, 'edited role defaults retain their coordinates')
  const compact = financialDefaultLayout('admin', { complexity: 'essentials', teamSize: 'solo' })
  const trade = financialDefaultLayout('admin', { complexity: 'essentials', industryCategory: 'trade' })
  assert.ok(compact.widgets.some((cell) => cell.id === 'kpi-items-to-reconcile'))
  assert.ok(trade.widgets.some((cell) => cell.id === 'kpi-gross-margin-mtd'))
  assert.ok(financialDefaultLayout('controller', {}).widgets.some((cell) => cell.id === 'kpi-overdue-payables'))
  assert.ok(financialDefaultLayout('approver', {}).widgets.some((cell) => cell.id === 'personal-inbox'))
  assert.ok(financialDefaultLayout('viewer', {}).widgets.every((cell) => cell.id !== 'personal-actions'))
})
