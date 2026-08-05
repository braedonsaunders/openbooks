import type { ReactNode } from 'react'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import {
  ArrowUpRight,
  Blocks,
  Boxes,
  Code,
  KeyRound,
  ScrollText,
  SlidersHorizontal,
  Tag,
  Workflow,
} from 'lucide-react'
import { PageHeader, cn } from '@openbooks/ui'
import { getAuthz, can } from '../../../../lib/authz'
import { featureEnabled, resolvedFeatureState } from '../../../../lib/features'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('admin')
  return { title: t('buildHub.metaTitle') }
}

// Per-accent class sets, kept as complete literal strings so Tailwind's scanner
// picks them up (dynamic `bg-${x}` names would be purged).
const ACCENTS = {
  teal: {
    chip: 'bg-teal-50 text-teal-700 ring-teal-100 dark:bg-teal-950/50 dark:text-teal-300',
    border: 'hover:border-teal-300 dark:hover:border-teal-700',
    link: 'group-hover:text-teal-600 dark:group-hover:text-teal-300',
  },
  violet: {
    chip: 'bg-violet-50 text-violet-700 ring-violet-100 dark:bg-violet-950/50 dark:text-violet-300',
    border: 'hover:border-violet-300 dark:hover:border-violet-700',
    link: 'group-hover:text-violet-600 dark:group-hover:text-violet-300',
  },
  amber: {
    chip: 'bg-amber-50 text-amber-700 ring-amber-100 dark:bg-amber-950/50 dark:text-amber-300',
    border: 'hover:border-amber-300 dark:hover:border-amber-700',
    link: 'group-hover:text-amber-600 dark:group-hover:text-amber-300',
  },
  sky: {
    chip: 'bg-sky-50 text-sky-700 ring-sky-100 dark:bg-sky-950/50 dark:text-sky-300',
    border: 'hover:border-sky-300 dark:hover:border-sky-700',
    link: 'group-hover:text-sky-600 dark:group-hover:text-sky-300',
  },
} as const

type Accent = keyof typeof ACCENTS
type Card = {
  href: string
  cardKey: string
  icon: ReactNode
  permission: string
  featureKey?: string
}
type Group = { key: string; labelKey: string; accent: Accent; cards: Card[] }

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
        icon: <Boxes size={18} />,
        cardKey: 'records',
        permission: 'records.manage_types',
      },
      {
        href: '/admin/custom-fields',
        icon: <Tag size={18} />,
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
        icon: <SlidersHorizontal size={18} />,
        cardKey: 'customization',
        permission: 'admin.customization.manage',
      },
      {
        href: '/admin/pdf-templates',
        icon: <ScrollText size={18} />,
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
        icon: <Workflow size={18} />,
        cardKey: 'scripts',
        permission: 'scripts.manage',
        featureKey: 'scripts',
      },
      {
        href: '/admin/apps',
        icon: <Blocks size={18} />,
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
        icon: <KeyRound size={18} />,
        cardKey: 'apiKeys',
        permission: 'api.keys.manage',
        featureKey: 'apiAccess',
      },
      {
        href: '/api-docs',
        icon: <Code size={18} />,
        cardKey: 'apiDocs',
        permission: 'api.keys.manage',
        featureKey: 'apiAccess',
      },
    ],
  },
]

export default async function BuildPage() {
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
          {groups.map((group) => {
            const accent = ACCENTS[group.accent]
            return (
              <section key={group.key} className="space-y-3">
                <h2 className="px-0.5 text-xs font-semibold tracking-wider text-slate-400 uppercase dark:text-slate-500">
                  {t(group.labelKey)}
                </h2>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                  {group.cards.map((card) => (
                    <Link
                      key={card.href}
                      href={card.href}
                      title={t(`hub.cards.${card.cardKey}.description`)}
                      className={cn(
                        'group flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm transition-all hover:shadow-md dark:border-slate-800 dark:bg-slate-900',
                        accent.border,
                      )}
                    >
                      <span
                        className={cn(
                          'grid h-10 w-10 shrink-0 place-items-center rounded-lg ring-1',
                          accent.chip,
                        )}
                      >
                        {card.icon}
                      </span>
                      <div className="min-w-0 flex-1">
                        <h3 className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
                          {t(`hub.cards.${card.cardKey}.title`)}
                        </h3>
                        <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                          {t(`hub.cards.${card.cardKey}.description`)}
                        </p>
                      </div>
                      <ArrowUpRight
                        size={15}
                        aria-hidden
                        className={cn(
                          'shrink-0 text-slate-300 opacity-0 transition-all duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:opacity-100 dark:text-slate-600',
                          accent.link,
                        )}
                      />
                    </Link>
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      </div>
    </div>
  )
}
