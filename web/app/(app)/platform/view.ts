import 'server-only'

import { frame, grid, page, pageHeader, ref, repeat, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { platformSummary } from '../../../lib/platform-admin'
import type { PlatformTileIconKey } from './sections'

/**
 * The platform hub, split into a loader and a spec.
 *
 * Four summary numbers come from one `platformSummary()` bypass query; the
 * stat (`toLocaleString`) and detail strings (the production/non-production
 * split, the super-admin plural, the two static labels) are presentation, so
 * they are built in the loader and travel as strings — the same rule that
 * keeps money and date formatting out of every other converted spec. The
 * icons stay behind `iconKey` lookups in `sections.tsx`, so the loader rows
 * are serializable.
 *
 * The page takes no searchParams at all, so the loader takes
 * no args and `currentParams` is absent: the tiles link to fixed paths.
 */

export interface PlatformHubTile {
  href: string
  iconKey: PlatformTileIconKey
  title: string
  description: string
  stat: string
  detail: string
}

export interface PlatformHubData {
  title: string
  description: string
  tiles: PlatformHubTile[]
}

export async function loadPlatformHub(): Promise<PlatformHubData> {
  const summary = await platformSummary()
  return {
    title: 'Super Admin',
    description: 'Platform-wide operations, identities, access controls, and delivery evidence.',
    tiles: [
      {
        href: '/platform/organizations',
        iconKey: 'building-2',
        title: 'Organizations',
        description: 'Every production company, sandbox, and preview environment',
        stat: summary.organizations.toLocaleString(),
        detail: `${summary.productionOrganizations} production · ${summary.environments} non-production`,
      },
      {
        href: '/platform/users',
        iconKey: 'users',
        title: 'Users',
        description: 'Global operator view of production identities and privileges',
        stat: summary.activeUsers.toLocaleString(),
        detail: `${summary.superAdmins} super administrator${summary.superAdmins === 1 ? '' : 's'}`,
      },
      {
        href: '/platform/access',
        iconKey: 'key-round',
        title: 'Cross-org access',
        description: 'Controlled mappings between login identities and organizations',
        stat: summary.activeGrants.toLocaleString(),
        detail: 'Active explicit grants',
      },
      {
        href: '/platform/email-log',
        iconKey: 'mail',
        title: 'Email log',
        description: 'Delivery evidence across every organization',
        stat: summary.failedEmails.toLocaleString(),
        detail: 'Failed deliveries requiring attention',
      },
    ],
  }
}

const f = ref<PlatformHubData>()

export function platformHubSpec(data: PlatformHubData): PageSpec {
  void data
  return page({
    route: '/platform',
    // The hub owns its own shell (PageContainer) the way the analytics hub
    // does — ListPageLayout's sticky-header chrome would nest a second shell
    // around it, so header and body concatenate and the frame renders the
    // exact native shell.
    layout: 'bare',
    header: [],
    body: [
      frame('page-container', [
        grid('space-y-6', [
          pageHeader({ title: f('title'), description: f('description') }),
          widgetBlock('platform-notice', {}),
          grid('grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4', [
            repeat({
              items: f('tiles'),
              itemKey: { $: 'href' },
              unwrapped: true,
              blocks: [
                widgetBlock('platform-tile', {
                  href: { $: 'href' },
                  iconKey: { $: 'iconKey' },
                  title: { $: 'title' },
                  description: { $: 'description' },
                  stat: { $: 'stat' },
                  detail: { $: 'detail' },
                }),
              ],
            }),
          ]),
        ]),
      ]),
    ],
  })
}
