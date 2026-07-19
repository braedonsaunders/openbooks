'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Search } from 'lucide-react'
import { cn } from '@openbooks/ui'
import type { DocCategory, DocNavArticle } from '../../lib/docs'

/**
 * Left navigation for the documentation center: a search box that filters the
 * bundled article index, plus a category → article tree. Active article is
 * derived from the pathname so it works under a server-rendered layout.
 */
export function DocsSidebar({ categories, articles }: { categories: DocCategory[]; articles: DocNavArticle[] }) {
  const t = useTranslations('docs')
  const pathname = usePathname()
  const [q, setQ] = useState('')

  const activeSlug = pathname?.startsWith('/docs/') ? pathname.slice('/docs/'.length) : ''

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return articles
    return articles.filter((a) => {
      const hay = `${a.title} ${a.summary} ${a.keywords.join(' ')}`.toLowerCase()
      return hay.includes(needle)
    })
  }, [q, articles])

  const groups = useMemo(
    () =>
      categories
        .map((category) => ({ category, items: filtered.filter((a) => a.category === category.key) }))
        .filter((g) => g.items.length > 0),
    [categories, filtered],
  )

  return (
    <nav className="flex h-full w-64 shrink-0 flex-col border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="border-b border-slate-200 p-3 dark:border-slate-800">
        <Link href="/docs" className="mb-3 block text-sm font-semibold text-slate-900 dark:text-slate-100">
          {t('title')}
        </Link>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" aria-hidden />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('searchPlaceholder')}
            aria-label={t('searchPlaceholder')}
            className="w-full rounded-md border border-slate-300 bg-slate-50 py-1.5 pl-8 pr-2.5 text-xs text-slate-800 placeholder:text-slate-400 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {groups.length === 0 ? (
          <p className="px-1 py-2 text-xs text-slate-500 dark:text-slate-400">{t('noResults')}</p>
        ) : (
          <div className="space-y-4">
            {groups.map(({ category, items }) => (
              <div key={category.key}>
                <div className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                  {category.title}
                </div>
                <ul className="space-y-0.5">
                  {items.map((a) => {
                    const active = a.slug === activeSlug
                    return (
                      <li key={a.slug}>
                        <Link
                          href={`/docs/${a.slug}`}
                          aria-current={active ? 'page' : undefined}
                          className={cn(
                            'block rounded px-2 py-1.5 text-sm transition-colors',
                            active
                              ? 'bg-teal-50 font-medium text-teal-700 dark:bg-teal-950/40 dark:text-teal-300'
                              : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100',
                          )}
                        >
                          {a.title}
                        </Link>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </nav>
  )
}
