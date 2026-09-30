import { DEFAULT_DASHBOARD_LAYOUTS, defaultDashboardLayoutForRole, type DashboardLayoutData } from '@openbooks/schema'
import type { IndustryDef } from '@/lib/industries'
import type { ComplexityLevel, TeamSize } from '@/lib/workspace-profile'
import { essentialsDefaultLayout } from './_essentials-layout'
import { packDefaultLayout } from './_default-layout'
import type { RoleTier } from './_role-tier'

export interface DashboardWorkspace {
  teamSize?: TeamSize
  complexity?: ComplexityLevel
  industryCategory?: IndustryDef['category']
}

/** Seeded product templates follow current presentation policy; edited role templates remain authoritative. */
export function isShippedRoleLayout(roleKey: string, layout: DashboardLayoutData): boolean {
  const template = defaultDashboardLayoutForRole(roleKey)
  return Boolean(template && Array.isArray(layout?.widgets) && !layout.quickActions && layout.widgets.length === template.widgets.length &&
    template.widgets.every((cell, index) => {
      const candidate = layout.widgets[index]
      return candidate && cell.id === candidate.id && cell.x === candidate.x && cell.y === candidate.y && cell.w === candidate.w && cell.h === candidate.h
    }))
}

/** Industry and size choose emphasis, never permissions, features or financial policy. */
export function financialDefaultLayout(role: RoleTier, workspace: DashboardWorkspace): DashboardLayoutData {
  const compact = workspace.complexity === 'essentials' ||
    (workspace.complexity !== 'advanced' && (workspace.teamSize === 'solo' || workspace.teamSize === 'small'))
  const essentials = essentialsDefaultLayout()
  const template = compact && role === 'admin' ? essentials : DEFAULT_DASHBOARD_LAYOUTS[role]
  let metrics = template.widgets.filter((cell) => cell.id.startsWith('kpi-')).map((cell) => cell.id)
  const trading = workspace.industryCategory === 'trade' || workspace.industryCategory === 'commerce'
  const services = workspace.industryCategory === 'services'
  if (trading && metrics.includes('kpi-expenses-mtd')) {
    metrics = metrics.map((id) => id === 'kpi-expenses-mtd' ? 'kpi-gross-margin-mtd' : id)
  }
  if (services && !compact && metrics.includes('kpi-gross-margin-mtd')) {
    metrics = metrics.map((id) => id === 'kpi-gross-margin-mtd' ? 'resourcing-pulse' : id)
  }
  const panelIds: Record<RoleTier, string[]> = {
    admin: ['inbox-list', 'list-close-readiness'],
    controller: ['list-pending-approvals', 'list-close-readiness'],
    accountant: ['personal-in-progress', 'list-recent-entries'],
    approver: ['personal-inbox', 'list-pending-approvals'],
    viewer: ['list-recent-entries'],
  }
  const selected = [...panelIds[role]]
  if (!compact && role !== 'approver') {
    if (trading && role !== 'viewer') selected.push('list-top-vendors')
    if (services && role === 'viewer') selected.push('list-top-customers')
    if (!selected.includes('list-recent-entries')) selected.push('list-recent-entries')
  }
  const panels = selected.map((id) => ({
    id, x: 0, y: 0, w: 6,
    h: role === 'admin' && (id === 'inbox-list' || id === 'list-close-readiness') ? 3 : 4,
  }))
  const actions = role !== 'viewer' && role !== 'approver'
  return packDefaultLayout({
    widgets: [
      ...(actions ? [{ id: 'personal-actions', x: 0, y: 0, w: 12, h: 2 }] : []),
      ...[...new Set(metrics)].map((id) => ({ id, x: 0, y: 0, w: 3, h: 2 })),
      ...panels,
    ],
    ...(actions ? { quickActions: essentials.quickActions } : {}),
  })
}
