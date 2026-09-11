import 'server-only'

import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getAuthz, can } from '../../../../lib/authz'
import { featureEnabled, resolvedFeatureState } from '../../../../lib/features'
import { grid, heading, page, pageHeader, ref, repeat, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'

/**
 * The Build hub — every authoring tool, mirroring the Platform hub's shell.
 * Card copy is shared with the Platform hub (`admin.hub.cards.*`); group
 * labels live under `admin.buildHub.groups`. Each card is re-gated by the
 * permission of the surface it opens.
 *
 * Loader, spec and widget shape mirror the admin-hub conversion exactly —
 * the two hubs share a shell and a card layout — except the card icons:
 * `BuildHubCard` carries its own icon map because the sets are disjoint
 * (see its note). Reusing `admin-hub-card` would put two components
 * behind one registry entry.
 */

type Card = {
  href: string
  iconKey: string
  cardKey: string
  permission: string
  featureKey?: string
}
type Group = { key: string; labelKey: string; accent: 'teal' | 'violet' | 'amber' | 'sky'; cards: Card[] }

const GROUPS: Group[] = [
  {
    key: 'model',
    labelKey: 'buildHub.groups.model',
    accent: 'violet',
    cards: [
      { href: '/records/types', iconKey: 'boxes', cardKey: 'records', permission: 'records.manage_types' },
      {
        href: '/admin/custom-fields',
        iconKey: 'tag',
        cardKey: 'customFields',
        permission: 'admin.custom_fields.manage',
      },
    ],
  },
  {
    key: 'experience',
    labelKey: 'buildHub.groups.experience',
    accent: 'teal',
    cards: [
      {
        href: '/admin/customization',
        iconKey: 'sliders-horizontal',
        cardKey: 'customization',
        permission: 'admin.customization.manage',
      },
      {
        href: '/admin/pdf-templates',
        iconKey: 'scroll-text',
        cardKey: 'pdfTemplates',
        permission: 'admin.customization.manage',
      },
    ],
  },
  {
    key: 'automation',
    labelKey: 'buildHub.groups.automation',
    accent: 'amber',
    cards: [
      {
        href: '/admin/scripts',
        iconKey: 'workflow',
        cardKey: 'scripts',
        permission: 'scripts.manage',
        featureKey: 'scripts',
      },
      {
        href: '/admin/apps',
        iconKey: 'blocks',
        cardKey: 'apps',
        permission: 'apps.manage',
        featureKey: 'apps',
      },
    ],
  },
  {
    key: 'api',
    labelKey: 'buildHub.groups.api',
    accent: 'sky',
    cards: [
      {
        href: '/admin/api-keys',
        iconKey: 'key-round',
        cardKey: 'apiKeys',
        permission: 'api.keys.manage',
        featureKey: 'apiAccess',
      },
      {
        href: '/api-docs',
        iconKey: 'code',
        cardKey: 'apiDocs',
        permission: 'api.keys.manage',
        featureKey: 'apiAccess',
      },
    ],
  },
]

export interface BuildHubCard {
  href: string
  iconKey: string
  title: string
  description: string
  accent: 'teal' | 'violet' | 'amber' | 'sky'
}

export interface BuildHubGroup {
  key: string
  label: string
  cards: BuildHubCard[]
}

export interface BuildHubData {
  title: string
  description: string
  groups: BuildHubGroup[]
}

export async function loadBuildHub(): Promise<BuildHubData> {
  const authz = await getAuthz()
  if (!authz) redirect('/login')
  const t = await getTranslations('admin')
  const featureState = await resolvedFeatureState(authz.user.orgId)

  const groups = GROUPS.map((g) => ({
    ...g,
    cards: g.cards.filter(
      (c) => can(authz, c.permission) && (!c.featureKey || featureEnabled(featureState, c.featureKey)),
    ),
  })).filter((g) => g.cards.length > 0)

  // No build-ish permission at all → this landing has nothing to show.
  if (groups.length === 0) redirect('/')

  return {
    title: t('buildHub.title'),
    description: t('buildHub.subtitle'),
    groups: groups.map((g) => ({
      key: g.key,
      label: t(g.labelKey),
      cards: g.cards.map((c) => ({
        href: c.href,
        iconKey: c.iconKey,
        title: t(`hub.cards.${c.cardKey}.title`),
        description: t(`hub.cards.${c.cardKey}.description`),
        accent: g.accent,
      })),
    })),
  }
}

const f = ref<BuildHubData>()

export function buildHubSpec(data: BuildHubData): PageSpec {
  void data
  return page({
    route: '/admin/build',
    // The hub owns its own full-height shell — ListPageLayout's centered
    // container would nest the chrome, so header and body concatenate.
    layout: 'bare',
    header: [],
    body: [
      grid('flex h-full min-h-0 flex-col', [
        // Fixed header — mirrors the Platform hub shell.
        grid(
          'shrink-0 border-b border-slate-200 bg-white px-3 py-3 sm:px-6 dark:border-slate-800 dark:bg-slate-900',
          [pageHeader({ title: f('title'), description: f('description') })],
        ),
        // Body scrolls internally, not the whole page.
        grid('app-scroll min-h-0 flex-1 overflow-y-auto bg-slate-50 dark:bg-slate-950', [
          grid('mx-auto w-full max-w-screen-2xl space-y-8 p-4 sm:p-6', [
            repeat({
              items: f('groups'),
              itemKey: { $: 'key' },
              unwrapped: true,
              blocks: [
                grid(
                  'space-y-3',
                  [
                    heading(2, { $: 'label' }, 'px-0.5 text-xs font-semibold tracking-wider text-slate-600 uppercase dark:text-slate-400'),
                    grid('grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4', [
                      repeat({
                        items: { $: 'cards' },
                        itemKey: { $: 'href' },
                        unwrapped: true,
                        blocks: [
                          widgetBlock('build-hub-card', {
                            href: { $: 'href' },
                            iconKey: { $: 'iconKey' },
                            title: { $: 'title' },
                            description: { $: 'description' },
                            accent: { $: 'accent' },
                          }),
                        ],
                      }),
                    ]),
                  ],
                  { as: 'section' },
                ),
              ],
            }),
          ]),
        ]),
      ]),
    ],
  })
}
