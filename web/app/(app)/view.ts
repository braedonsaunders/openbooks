import 'server-only'

import { getTranslations } from 'next-intl/server'
import { frame, grid, page, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { getAuthz } from '@/lib/authz'

import { buildGreeting } from './dashboard/_greeting'

/**
 * The root dashboard (`/`), split into a loader and a spec.
 *
 * This page is byte-identical in intent to `/dashboard`: the same
 * `getTranslations('dashboard')` greeting over the same
 * `dashboard.greeting.*` keys, the same `getAuthz` null branch, and the same
 * `<PageContainer><div className="space-y-5">` wrapper. The only difference
 * is that the layout resolution, the `canSeeWidget` filter, the stale-node
 * prune, the tile nodes and the bound `saveQuickActions` action all live in
 * the `dashboard-grid` SLOT (which re-derives them from the session) — the
 * same doctrine as the `record-list-slot` rule: the loader owns data, the
 * HOST owns capabilities. A spec carrying a `Record<string, ReactNode>` of
 * rendered tiles would carry component references, and one carrying a bound
 * server action would hand an authority to whoever can name the block — and a
 * tenant- or agent-authored spec is exactly that.
 *
 * What the loader CAN express, it does: the greeting, over the same
 * `dashboard.greeting.*` keys the native page uses.
 */

export interface RootDashboardData {
  greeting: string
}

export async function loadRootDashboard(
  _sp: Record<string, string | string[] | undefined>,
): Promise<RootDashboardData | null> {
  const t = await getTranslations('dashboard')
  const authz = await getAuthz()
  if (!authz) return null

  // Layout resolution, the `canSeeWidget` filter and the stale-node prune all
  // live in the slot now — they need the session, and re-deriving them there
  // is what keeps them out of the spec.

  // Keep the comment the native page carries: the hour comes from the server
  // clock and the name is the user's own first name.
  const today = new Date()
  return {
    greeting: buildGreeting(today, authz.user.name, {
      morning: t('greeting.morning'),
      afternoon: t('greeting.afternoon'),
      evening: t('greeting.evening'),
    }),
  }
}

export function rootDashboardSpec(data: RootDashboardData): PageSpec {
  return page({
    // The native page renders inside PageContainer (not the sticky
    // ListPageLayout chrome), so the spec is bare and places the container
    // itself through the `page-container` frame — the platform-hub precedent.
    layout: 'bare',
    body: [
      frame('page-container', [
        // Exact wrapper from page.tsx: <div className="space-y-5">.
        grid('space-y-5', [
          widgetBlock('dashboard-header', { greeting: data.greeting }),
          // No props: the slot re-derives everything from the session.
          widgetBlock('dashboard-grid'),
        ]),
      ]),
    ],
  })
}
