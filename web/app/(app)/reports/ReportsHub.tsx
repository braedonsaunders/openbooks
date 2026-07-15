'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import {
  ArrowUpRight,
  Bookmark,
  BookOpen,
  CalendarClock,
  ClipboardList,
  Coins,
  FileText,
  Landmark,
  NotebookPen,
  Receipt,
  Scale,
  Search,
  Sparkles,
  Target,
  Wallet,
  Waves,
} from 'lucide-react'
import { Input, cn } from '@openbooks/ui'
import { NewReportButton } from './custom/NewReportButton'

const ICONS: Record<string, typeof FileText> = {
  FileText,
  Scale,
  Waves,
  ClipboardList,
  BookOpen,
  NotebookPen,
  CalendarClock,
  Receipt,
  Wallet,
  Landmark,
  Target,
  Sparkles,
  Coins,
  Bookmark,
}

// Full literal accent class sets so Tailwind's scanner keeps them.
const ACCENTS: Record<string, { chip: string; border: string; link: string }> = {
  teal: {
    chip: 'bg-teal-50 text-teal-700 ring-teal-100 dark:bg-teal-950/50 dark:text-teal-300',
    border: 'hover:border-teal-300 dark:hover:border-teal-700',
    link: 'group-hover:text-teal-600 dark:group-hover:text-teal-300',
  },
  sky: {
    chip: 'bg-sky-50 text-sky-700 ring-sky-100 dark:bg-sky-950/50 dark:text-sky-300',
    border: 'hover:border-sky-300 dark:hover:border-sky-700',
    link: 'group-hover:text-sky-600 dark:group-hover:text-sky-300',
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
  slate: {
    chip: 'bg-slate-100 text-slate-600 ring-slate-200 dark:bg-slate-800 dark:text-slate-300',
    border: 'hover:border-slate-300 dark:hover:border-slate-600',
    link: 'group-hover:text-slate-700 dark:group-hover:text-slate-200',
  },
}

export type HubCard = { href: string; title: string; desc: string; icon: string }
export type HubGroup = { key: string; label: string; accent: string; cards: HubCard[] }

export function ReportsHub({
  title,
  description,
  groups,
  canCreate,
}: {
  title: string
  description: string
  groups: HubGroup[]
  canCreate: boolean
}) {
  const t = useTranslations('reports.hub')
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return groups
    return groups
      .map((g) => ({
        ...g,
        cards: g.cards.filter((c) => c.title.toLowerCase().includes(needle) || c.desc.toLowerCase().includes(needle)),
      }))
      .filter((g) => g.cards.length > 0)
  }, [groups, query])

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">{title}</h1>
            <p className="max-w-2xl text-sm text-slate-500 dark:text-slate-400">{description}</p>
          </div>
          {canCreate && <NewReportButton />}
        </div>
        <div className="relative max-w-sm">
          <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('searchPlaceholder')}
            className="pl-9"
            aria-label={t('searchPlaceholder')}
          />
        </div>
      </header>

      {filtered.length === 0 ? (
        <p className="py-8 text-center text-sm text-slate-400 italic">{t('noMatches')}</p>
      ) : (
        filtered.map((group) => {
          const accent = ACCENTS[group.accent] ?? ACCENTS.slate!
          return (
            <section key={group.key} className="space-y-2.5">
              <h2 className="px-0.5 text-xs font-semibold tracking-wider text-slate-400 uppercase dark:text-slate-500">
                {group.label}
              </h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                {group.cards.map((card) => {
                  const Icon = ICONS[card.icon] ?? FileText
                  return (
                    <Link
                      key={card.href}
                      href={card.href}
                      title={card.desc}
                      className={cn(
                        'group flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm transition-colors dark:border-slate-800 dark:bg-slate-900',
                        accent.border,
                      )}
                    >
                      <span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-lg ring-1', accent.chip)}>
                        <Icon size={18} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <h3 className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">{card.title}</h3>
                        <p className="truncate text-xs text-slate-500 dark:text-slate-400">{card.desc}</p>
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
                  )
                })}
              </div>
            </section>
          )
        })
      )}
    </div>
  )
}
