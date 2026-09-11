import 'server-only'

import { getTranslations } from 'next-intl/server'
import { frame, grid, page, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { getAuthz } from '../../../../lib/authz'
import { loadDashboardLayout } from '../_load-layout'
import { ROLE_TIER_LABELS } from '../_role-tier'

/**
 * The dashboard customise page, split into a loader and a spec.
 *
 * The canvas is a SLOT (`dashboard-edit`), for the same reason the view-mode
 * grid is, only more so. Edit mode needs rendered tile nodes, a bound
 * `saveQuickActions` server action, AND `allowedWidgetIds` — a permission
 * decision computed per caller. A spec is data; data carrying a permission set
 * is a decision made somewhere a tenant-authored spec could reach. So none of
 * it travels, and the slot re-derives all of it from the session.
 *
 * The loader resolves only the heading strings. It does read the layout, but
 * for one reason: the role line names the caller's tier, and that comes from
 * the same resolution the slot performs. Reading it twice is the cost of not
 * passing a permission decision through a spec, and it is the right trade.
 */

export interface CustomizeDashboardData {
  backHref: string
  backLabel: string
  title: string
  roleLabel: string
}

export async function loadCustomizeDashboard(): Promise<CustomizeDashboardData | null> {
  const t = await getTranslations('dashboard')
  const authz = await getAuthz()
  if (!authz) return null

  const { role } = await loadDashboardLayout(authz)

  return {
    backHref: '/dashboard',
    backLabel: t('customize.back'),
    title: t('customize.title'),
    roleLabel: t('customize.roleLabel', { role: ROLE_TIER_LABELS[role] }),
  }
}

export function customizeDashboardSpec(data: CustomizeDashboardData): PageSpec {
  return page({
    route: '/dashboard/customize',
    // The native page renders inside PageContainer, not the sticky
    // ListPageLayout chrome — the platform-hub arrangement.
    layout: 'bare',
    header: [],
    body: [
      frame('page-container', [
        // Exact wrapper from page.tsx: <div className="space-y-4">.
        grid('space-y-4', [
          widgetBlock('dashboard-customize-header', {
            backHref: data.backHref,
            backLabel: data.backLabel,
            title: data.title,
            roleLabel: data.roleLabel,
          }),
          // No props: the slot re-derives layout, nodes, the allowed-widget
          // set, the bound action and its own remount key from the session.
          widgetBlock('dashboard-edit'),
        ]),
      ]),
    ],
  })
}
