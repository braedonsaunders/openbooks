import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@openbooks/ui'
import { getAuthz, can } from '../../../../lib/authz'
import { featureEnabled, resolvedFeatureState } from '../../../../lib/features'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadBuildHub, buildHubSpec } from './view'
import { BuildHubCard, type BuildHubAccent } from './sections'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('admin')
  return { title: t('buildHub.metaTitle') }
}

type Card = {
  href: string
  iconKey: string
  cardKey: string
  permission: string
  featureKey?: string
}
type Group = { key: string; labelKey: string; accent: BuildHubAccent; cards: Card[] }

// The Build hub — every authoring tool, mirroring the Platform hub's shell.
// Card copy is shared with the Platform hub (`admin.hub.cards.*`); group
// labels live under `admin.buildHub.groups`. Each card is re-gated by the
// permission of the surface it opens.
const GROUPS: Group[] = [
  {
    key: 'model',
    labelKey: 'buildHub.groups.model',
    accent: 'violet',
    cards: [
      {
        href: '/records/types',
        iconKey: 'boxes',
        cardKey: 'records',
        permission: 'records.manage_types',
      },
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

export default async function BuildPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  if ((await searchParams).__viewspec === '1') {
    const sp = await searchParams
    const data = await loadBuildHub()
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={buildHubSpec(data)} data={data} searchParams={sp} trusted />
      </>
    )
  }
  const authz = await getAuthz()
  if (!authz) redirect('/login')
  const t = await getTranslations('admin')
  const featureState = await resolvedFeatureState(authz.user.orgId)

  const groups = GROUPS.map((g) => ({
    ...g,
    cards: g.cards.filter((c) => can(authz, c.permission) && (!c.featureKey || featureEnabled(featureState, c.featureKey))),
  })).filter((g) => g.cards.length > 0)

  // No build-ish permission at all → this landing has nothing to show.
  if (groups.length === 0) redirect('/')

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Fixed header — mirrors the Platform hub shell */}
      <div className="shrink-0 border-b border-slate-200 bg-white px-3 py-3 sm:px-6 dark:border-slate-800 dark:bg-slate-900">
        <PageHeader title={t('buildHub.title')} description={t('buildHub.subtitle')} />
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
                  <BuildHubCard
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
