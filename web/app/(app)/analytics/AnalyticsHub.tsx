'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import {
  Activity,
  ArrowUpRight,
  Clock,
  Gauge,
  Search,
  ShieldAlert,
  Users,
  Wallet,
  Zap,
  Coins,
  Truck,
  type LucideIcon,
} from 'lucide-react'
import { Input, cn } from '@openbooks/ui'

const ICONS: Record<string, LucideIcon> = {
  Activity,
  Coins,
  Wallet,
  Clock,
  Users,
  Truck,
  ShieldAlert,
  Zap,
  Gauge,
}

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
}

export type AnalyticsCard = { href: string; title: string; desc: string; icon: string; planned?: boolean }
export type AnalyticsGroup = { key: string; label: string; accent: string; cards: AnalyticsCard[] }

export function AnalyticsHub({
  title,
  description,
  groups,
}: {
  title: string
  description: string
  groups: AnalyticsGroup[]
}) {
  const t = useTranslations('analytics.hub')
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
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">{title}</h1>
          <p className="max-w-2xl text-sm text-slate-500 dark:text-slate-400">{description}</p>
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
          const accent = ACCENTS[group.accent] ?? ACCENTS.teal!
          return (
            <section key={group.key} className="space-y-2.5">
              <h2 className="px-0.5 text-xs font-semibold tracking-wider text-slate-400 uppercase dark:text-slate-500">
                {group.label}
              </h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                {group.cards.map((card) => {
                  const Icon = ICONS[card.icon] ?? Activity
                  const body = (
                    <>
                      <span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-lg ring-1', accent.chip)}>
                        <Icon size={18} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <h3 className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">{card.title}</h3>
                          {card.planned && (
                            <span className="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-slate-500 uppercase dark:bg-slate-800 dark:text-slate-400">
                              {t('planned')}
                            </span>
                          )}
                        </div>
                        <p className="truncate text-xs text-slate-500 dark:text-slate-400">{card.desc}</p>
                      </div>
                      {!card.planned && (
                        <ArrowUpRight
                          size={15}
                          aria-hidden
                          className={cn(
                            'shrink-0 text-slate-300 opacity-0 transition-all duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:opacity-100 dark:text-slate-600',
                            accent.link,
                          )}
                        />
                      )}
                    </>
                  )
                  const base = 'group flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm transition-colors dark:border-slate-800 dark:bg-slate-900'
                  return card.planned ? (
                    <div key={card.title} title={card.desc} className={cn(base, 'cursor-default opacity-70')}>
                      {body}
                    </div>
                  ) : (
                    <Link key={card.href} href={card.href} title={card.desc} className={cn(base, accent.border)}>
                      {body}
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
