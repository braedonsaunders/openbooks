import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@openbooks/ui'
import { getAuthz, can } from '../../../lib/authz'
import { featureEnabled, resolvedFeatureState } from '../../../lib/features'
import { ModuleView } from '../../../components/viewspec/module-view'
import { loadAdminHub, adminHubSpec } from './view'
import { AdminHubCard, type AdminHubAccent } from './sections'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('admin')
  return { title: t('hub.metaTitle') }
}

type Card = {
  href: string
  iconKey: string
  cardKey: string
  permission: string
  featureKey?: string
}
type Group = { key: string; labelKey: string; accent: AdminHubAccent; cards: Card[] }

// The admin hub. Every card is gated by the permission of the surface it opens;
// the whole page is gated by holding at least one of them. Navigation is
// client-side (<Link>) — never a full reload. Copy lives in the `admin.hub`
// message namespace; this module-level constant stores only message keys.
// Most authoring tools live in the sidebar's Settings → Build sub-menu.
// PDF Templates is also surfaced here because it is a common company-output
// control, while still linking to the one authoritative template workspace.
// Keep ADMIN_HUB_PERMISSIONS in the nav registry in sync with these cards.
const GROUPS: Group[] = [
  {
    key: 'people',
    labelKey: 'hub.groups.people',
    accent: 'violet',
    cards: [
      { href: '/admin/users', iconKey: 'users', cardKey: 'users', permission: 'admin.users.manage' },
      {
        href: '/admin/roles',
        iconKey: 'shield-check',
        cardKey: 'roles',
        permission: 'admin.roles.manage',
      },
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
      {
        href: '/admin/audit',
        iconKey: 'scroll-text',
        cardKey: 'audit',
        permission: 'admin.audit.read',
      },
      { href: '/sync', iconKey: 'link', cardKey: 'sync', permission: 'sync.run' },
    ],
  },
]

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  if ((await searchParams).__viewspec === '1') {
    const sp = await searchParams
    const data = await loadAdminHub()
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={adminHubSpec(data)} data={data} searchParams={sp} trusted />
      </>
    )
  }
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Fixed header — mirrors the Setup workspace shell */}
      <div className="shrink-0 border-b border-slate-200 bg-white px-3 py-3 sm:px-6 dark:border-slate-800 dark:bg-slate-900">
        <PageHeader title={t('hub.title')} description={t('hub.subtitle')} />
      </div>

      {/* Body scrolls internally, not the whole page */}
      <div className="app-scroll min-h-0 flex-1 overflow-y-auto bg-slate-50 dark:bg-slate-950">
        <div className="mx-auto w-full max-w-screen-2xl space-y-8 p-4 sm:p-6">
          {groups.map((group) => (
            <section key={group.key} className="space-y-3">
              <h2 className="px-0.5 text-xs font-semibold tracking-wider text-slate-600 uppercase dark:text-slate-400">
                {t(group.labelKey)}
              </h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                {group.cards.map((card) => (
                  <AdminHubCard
                    key={card.href}
                    href={card.href}
                    iconKey={card.iconKey}
                    title={t(`hub.cards.${card.cardKey}.title`)}
                    description={t(`hub.cards.${card.cardKey}.description`)}
                    accent={group.accent}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
