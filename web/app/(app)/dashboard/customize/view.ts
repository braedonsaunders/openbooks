import 'server-only'

import { getTranslations } from 'next-intl/server'
import { frame, grid, page, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { getAuthz } from '../../../../lib/authz'
import { getUserRoleTier, ROLE_TIER_LABEL_KEYS } from '../_role-tier'

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
 * The heading's role tier derives from the authenticated principal. Layout
 * and widget authority stay inside the slot, which resolves them once for
 * its canvas without passing permission decisions through the spec.
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

  const role = getUserRoleTier(authz)

  return {
    backHref: '/dashboard',
    backLabel: t('customize.back'),
    title: t('customize.title'),
    roleLabel: t('customize.roleLabel', { role: t(ROLE_TIER_LABEL_KEYS[role]) }),
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
