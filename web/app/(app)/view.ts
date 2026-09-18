import 'server-only'

import { getTranslations } from 'next-intl/server'
import { frame, grid, page, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { getAuthz } from '@/lib/authz'

import { businessTimeZone } from '@openbooks/engine/src/business-date.ts'
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
  name: string | null
}

export async function loadRootDashboard(): Promise<RootDashboardData | null> {
  const t = await getTranslations('dashboard')
  const authz = await getAuthz()
  if (!authz) return null

  // Layout resolution, the `canSeeWidget` filter and the stale-node prune all
  // live in the slot now — they need the session, and re-deriving them there
  // is what keeps them out of the spec.

  // The server paint uses the org zone; the header corrects to the browser
  // zone on mount. The name is the user's own first name.
  const today = new Date()
  return {
    greeting: buildGreeting(today, authz.user.name, {
      morning: t('greeting.morning'),
      afternoon: t('greeting.afternoon'),
      evening: t('greeting.evening'),
    }, await businessTimeZone(authz.user.orgId)),
    name: authz.user.name,
  }
}

export function rootDashboardSpec(data: RootDashboardData): PageSpec {
  return page({
    route: '/',
    // The native page renders inside PageContainer (not the sticky
    // ListPageLayout chrome), so the spec is bare and places the container
    // itself through the `page-container` frame — the platform-hub precedent.
    layout: 'bare',
    body: [
      frame('page-container', [
        // Exact wrapper from page.tsx: <div className="space-y-5">.
        grid('space-y-5', [
          widgetBlock('dashboard-header', { greeting: data.greeting, name: data.name }),
          // No props: the slot re-derives everything from the session.
          widgetBlock('dashboard-grid'),
        ]),
      ]),
    ],
  })
}
