import 'server-only'

import { getTranslations } from 'next-intl/server'
import { frame, grid, page, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { getAuthz } from '../../../lib/authz'

import { buildGreeting } from './_greeting'

/**
 * The home dashboard, split into a loader and a spec.
 *
 * The tile grid is a SLOT (`dashboard-grid`), not a widget carrying props,
 * and the reason is the strictest rule in this language. `DashboardGrid`
 * needs a `Record<string, ReactNode>` of rendered tiles and a bound
 * `saveQuickActions` server action. A spec is data. Data carrying a bound
 * server action is an authority handed to whoever can name the block — and a
 * tenant- or agent-authored spec is exactly that. So none of it travels: the
 * slot re-derives the layout, the visibility filter, the tile nodes and the
 * action from the session, and the spec places it with no props at all. The
 * `record-list-slot` rule, unchanged: the loader owns data, the HOST owns
 * capabilities.
 *
 * The grid is also genuinely un-decomposable — a live `react-grid-layout`
 * canvas with drag/resize callbacks, ResizeObserver measurement and viewport
 * media queries, over tiles that each read a context, self-fetch, or hold
 * editor state. That is interactive client state, not blocks.
 *
 * What the loader CAN express, it does: the greeting, over the same
 * `dashboard.greeting.*` keys the native page uses.
 */

export interface DashboardData {
  greeting: string
}

export async function loadDashboard(
  _sp: Record<string, string | string[] | undefined>,
): Promise<DashboardData | null> {
  const t = await getTranslations('dashboard')
  const authz = await getAuthz()
  if (!authz) return null

  // Layout resolution, the `canSeeWidget` filter and the stale-node prune all
  // live in the slot now — they need the session, and re-deriving them there
  // is what keeps them out of the spec.
  return {
    greeting: buildGreeting(new Date(), authz.user.name, {
      morning: t('greeting.morning'),
      afternoon: t('greeting.afternoon'),
      evening: t('greeting.evening'),
    }),
  }
}

export function dashboardSpec(data: DashboardData): PageSpec {
  return page({
    route: '/dashboard',
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
