import 'server-only'

import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getAuthz, can } from '../../../lib/authz'
import { featureEnabled, resolvedFeatureState } from '../../../lib/features'
import { grid, heading, page, pageHeader, ref, repeat, widgetBlock, type PageSpec } from '@openbooks/viewspec'

// The admin hub. Every card is gated by the permission of the surface it opens;
// the whole page is gated by holding at least one of them. Copy lives in the
// `admin.hub` message namespace; this module-level constant stores only message
// keys. Keep ADMIN_HUB_PERMISSIONS in the nav registry in sync with these cards.
const GROUPS: { key: string; labelKey: string; accent: Accent; cards: Card[] }[] = [
  {
    key: 'people',
    labelKey: 'hub.groups.people',
    accent: 'violet',
    cards: [
      { href: '/admin/users', iconKey: 'users', cardKey: 'users', permission: 'admin.users.manage' },
      { href: '/admin/roles', iconKey: 'shield-check', cardKey: 'roles', permission: 'admin.roles.manage' },
    ],
  },
  {
    key: 'workspace',
    labelKey: 'hub.groups.workspace',
    accent: 'amber',
    cards: [
      { href: '/admin/ai', iconKey: 'sparkles', cardKey: 'ai', permission: 'admin.ai.manage' },
      {
        href: '/admin/navigation',
        iconKey: 'panel-left',
        cardKey: 'navigation',
        permission: 'admin.nav.manage',
      },
      { href: '/admin/email', iconKey: 'mail', cardKey: 'email', permission: 'admin.setup.manage' },
      {
        href: '/admin/pdf-templates',
        iconKey: 'scroll-text',
        cardKey: 'pdfTemplates',
        permission: 'admin.customization.manage',
      },
    ],
  },
  {
    key: 'platform',
    labelKey: 'hub.groups.platform',
    accent: 'teal',
    cards: [
      {
        href: '/admin/scripts',
        iconKey: 'code-2',
        cardKey: 'scripts',
        permission: 'scripts.manage',
        featureKey: 'scripts',
      },
      {
        href: '/admin/flows',
        iconKey: 'workflow',
        cardKey: 'flows',
        permission: 'flows.manage',
        featureKey: 'flows',
      },
      {
        href: '/admin/apps',
        iconKey: 'blocks',
        cardKey: 'apps',
        permission: 'apps.manage',
        featureKey: 'apps',
      },
      {
        href: '/admin/api-keys',
        iconKey: 'key-round',
        cardKey: 'apiKeys',
        permission: 'api.keys.manage',
        featureKey: 'apiAccess',
      },
      {
        href: '/api-docs',
        iconKey: 'code-2',
        cardKey: 'apiDocs',
        permission: 'api.keys.manage',
        featureKey: 'apiAccess',
      },
      {
        href: '/query',
        iconKey: 'database',
        cardKey: 'queryConsole',
        permission: 'sql.execute',
        featureKey: 'queryConsole',
      },
    ],
  },
  {
    key: 'data',
    labelKey: 'hub.groups.data',
    accent: 'sky',
    cards: [
      {
        href: '/admin/sandboxes',
        iconKey: 'boxes',
        cardKey: 'sandboxes',
        permission: 'admin.sandboxes.manage',
      },
      {
        href: '/admin/backups',
        iconKey: 'database-backup',
        cardKey: 'backup',
        permission: 'admin.backups.manage',
      },
      { href: '/admin/audit', iconKey: 'scroll-text', cardKey: 'audit', permission: 'admin.audit.read' },
      { href: '/sync', iconKey: 'link', cardKey: 'sync', permission: 'sync.run' },
    ],
  },
]

type Accent = 'teal' | 'violet' | 'amber' | 'sky'
type Card = {
  href: string
  iconKey: string
  cardKey: string
  permission: string
  featureKey?: string
}

export interface AdminHubCard {
  href: string
  iconKey: string
  title: string
  description: string
  accent: Accent
}

export interface AdminHubGroup {
  key: string
  label: string
  cards: AdminHubCard[]
}

export interface AdminHubData {
  title: string
  description: string
  groups: AdminHubGroup[]
}

export async function loadAdminHub(): Promise<AdminHubData> {
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

  // No admin-ish permission at all → this landing has nothing to show.
  if (groups.length === 0) redirect('/')

  return {
    title: t('hub.title'),
    description: t('hub.subtitle'),
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

const f = ref<AdminHubData>()

export function adminHubSpec(data: AdminHubData): PageSpec {
  void data
  return page({
    route: '/admin',
    // The hub owns its own full-height shell — ListPageLayout's centered
    // container would nest the chrome, so header and body concatenate.
    layout: 'bare',
    header: [],
    body: [
      grid('flex h-full min-h-0 flex-col', [
        // Fixed header — mirrors the Setup workspace shell.
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
                          widgetBlock('admin-hub-card', {
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
