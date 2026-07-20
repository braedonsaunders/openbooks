'use client'

import { useEffect, useMemo, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { BookOpen, ChevronDown, ChevronRight, Search } from 'lucide-react'
import { cn } from '@openbooks/ui'
import type { DocCategory, DocNavArticle, DocSection } from '../../lib/docs'

function ancestorsOf(sectionKey: string | undefined, sectionByKey: Map<string, DocSection>): string[] {
  const ancestors: string[] = []
  const visited = new Set<string>()
  let key = sectionKey
  while (key && !visited.has(key)) {
    visited.add(key)
    ancestors.unshift(key)
    key = sectionByKey.get(key)?.parentKey
  }
  return ancestors
}

/**
 * Searchable category → topic group → article tree. Categories and topic
 * groups collapse independently; search temporarily expands matching ancestry,
 * and navigating to an article always opens the branch that contains it.
 */
export function DocsSidebar({
  categories,
  sections,
  articles,
}: {
  categories: DocCategory[]
  sections: DocSection[]
  articles: DocNavArticle[]
}) {
  const t = useTranslations('docs')
  const pathname = usePathname()
  const [q, setQ] = useState('')
  const activeSlug = pathname?.startsWith('/docs/') ? pathname.slice('/docs/'.length) : ''

  const sectionByKey = useMemo(() => new Map(sections.map((section) => [section.key, section])), [sections])
  const categoryByKey = useMemo(() => new Map(categories.map((category) => [category.key, category])), [categories])
  const activeArticle = articles.find((article) => article.slug === activeSlug)
  const initialCategory = activeArticle?.category ?? categories[0]?.key
  const initialSections = activeArticle?.section
    ? ancestorsOf(activeArticle.section, sectionByKey)
    : sections.filter((section) => section.category === initialCategory && !section.parentKey).slice(0, 1).map((section) => section.key)

  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    () => new Set(initialCategory ? [initialCategory] : []),
  )
  const [expandedSections, setExpandedSections] = useState<Set<string>>(() => new Set(initialSections))

  useEffect(() => {
    if (!activeArticle) return
    setExpandedCategories((current) => new Set(current).add(activeArticle.category))
    if (activeArticle.section) {
      const path = ancestorsOf(activeArticle.section, sectionByKey)
      setExpandedSections((current) => {
        const next = new Set(current)
        for (const key of path) next.add(key)
        return next
      })
    }
  }, [activeArticle, sectionByKey])

  const needle = q.trim().toLowerCase()
  const filtered = useMemo(() => {
    if (!needle) return articles
    return articles.filter((article) => {
      const section = article.section ? sectionByKey.get(article.section) : undefined
      const category = categoryByKey.get(article.category)
      const haystack = [article.title, article.summary, article.keywords.join(' '), section?.title, category?.title]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return haystack.includes(needle)
    })
  }, [articles, categoryByKey, needle, sectionByKey])

  const visibleSectionKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const article of filtered) {
      for (const key of ancestorsOf(article.section, sectionByKey)) keys.add(key)
    }
    return keys
  }, [filtered, sectionByKey])

  const groups = useMemo(
    () =>
      categories
        .map((category) => ({
          category,
          items: filtered.filter((article) => article.category === category.key),
          rootSections: sections
            .filter(
              (section) =>
                section.category === category.key && !section.parentKey && visibleSectionKeys.has(section.key),
            )
            .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title)),
        }))
        .filter((group) => group.items.length > 0),
    [categories, filtered, sections, visibleSectionKeys],
  )

  function toggle(setter: Dispatch<SetStateAction<Set<string>>>, key: string) {
    setter((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function descendantCount(sectionKey: string, items: DocNavArticle[]): number {
    const own = items.filter((article) => article.section === sectionKey).length
    const children = sections.filter((section) => section.parentKey === sectionKey)
    return own + children.reduce((sum, child) => sum + descendantCount(child.key, items), 0)
  }

  function renderArticles(items: DocNavArticle[], className?: string) {
    if (items.length === 0) return null
    return (
      <ul className={cn('space-y-0.5', className)}>
        {items.map((article) => {
          const active = article.slug === activeSlug
          return (
            <li key={article.slug}>
              <Link
                href={`/docs/${article.slug}`}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'block rounded py-1.5 pr-2 text-sm transition-colors',
                  article.section ? 'pl-7' : 'pl-6',
                  active
                    ? 'bg-teal-50 font-medium text-teal-700 dark:bg-teal-950/40 dark:text-teal-300'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100',
                )}
              >
                {article.title}
              </Link>
            </li>
          )
        })}
      </ul>
    )
  }

  function renderSection(section: DocSection, items: DocNavArticle[]) {
    const ownArticles = items.filter((article) => article.section === section.key)
    const children = sections
      .filter((candidate) => candidate.parentKey === section.key && visibleSectionKeys.has(candidate.key))
      .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
    const expanded = Boolean(needle) || expandedSections.has(section.key)
    const count = descendantCount(section.key, items)

    return (
      <li key={section.key}>
        <button
          type="button"
          onClick={() => toggle(setExpandedSections, section.key)}
          aria-expanded={expanded}
          aria-label={t(expanded ? 'collapseSection' : 'expandSection', { title: section.title })}
          className="flex w-full items-center gap-1.5 rounded py-1.5 pl-3 pr-2 text-left text-xs font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100"
        >
          <ChevronRight
            className={cn('h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform', expanded && 'rotate-90')}
            aria-hidden
          />
          <span className="min-w-0 flex-1 truncate">{section.title}</span>
          <span className="text-[10px] tabular-nums text-slate-400 dark:text-slate-500">{count}</span>
        </button>
        {expanded ? (
          <div className="ml-4 border-l border-slate-200 pl-1 dark:border-slate-800">
            {renderArticles(ownArticles)}
            {children.length > 0 ? <ul className="space-y-0.5">{children.map((child) => renderSection(child, items))}</ul> : null}
          </div>
        ) : null}
      </li>
    )
  }

  function renderArticleTree() {
    if (groups.length === 0) {
      return <p className="px-1 py-2 text-xs text-slate-500 dark:text-slate-400">{t('noResults')}</p>
    }
    return (
      <div className="space-y-1">
        {groups.map(({ category, items, rootSections }) => {
          const expanded = Boolean(needle) || expandedCategories.has(category.key)
          const rootArticles = items.filter((article) => !article.section)
          return (
            <section key={category.key}>
              <button
                type="button"
                onClick={() => toggle(setExpandedCategories, category.key)}
                aria-expanded={expanded}
                aria-label={t(expanded ? 'collapseSection' : 'expandSection', { title: category.title })}
                className="flex w-full items-center gap-1.5 rounded px-1 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
              >
                <ChevronRight
                  className={cn('h-3.5 w-3.5 shrink-0 transition-transform', expanded && 'rotate-90')}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate">{category.title}</span>
                <span className="text-[10px] tabular-nums text-slate-400 dark:text-slate-500">{items.length}</span>
              </button>
              {expanded ? (
                <div className="pb-1">
                  {renderArticles(rootArticles)}
                  {rootSections.length > 0 ? (
                    <ul className="space-y-0.5">{rootSections.map((section) => renderSection(section, items))}</ul>
                  ) : null}
                </div>
              ) : null}
            </section>
          )
        })}
      </div>
    )
  }

  const search = (
    <div className="relative">
      <Search
        className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
        aria-hidden
      />
      <input
        type="search"
        value={q}
        onChange={(event) => setQ(event.target.value)}
        placeholder={t('searchPlaceholder')}
        aria-label={t('searchPlaceholder')}
        className="w-full rounded-md border border-slate-300 bg-slate-50 py-1.5 pl-8 pr-2.5 text-xs text-slate-800 placeholder:text-slate-400 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200"
      />
    </div>
  )

  const treeControls = !needle ? (
    <div className="mt-2 flex items-center gap-2 text-[11px]">
      <button
        type="button"
        onClick={() => {
          setExpandedCategories(new Set(categories.map((category) => category.key)))
          setExpandedSections(new Set(sections.map((section) => section.key)))
        }}
        className="text-slate-500 hover:text-teal-700 dark:text-slate-400 dark:hover:text-teal-300"
      >
        {t('expandAll')}
      </button>
      <span className="text-slate-300 dark:text-slate-700" aria-hidden>·</span>
      <button
        type="button"
        onClick={() => {
          setExpandedCategories(new Set())
          setExpandedSections(new Set())
        }}
        className="text-slate-500 hover:text-teal-700 dark:text-slate-400 dark:hover:text-teal-300"
      >
        {t('collapseAll')}
      </button>
    </div>
  ) : null

  return (
    <>
      <nav className="hidden h-full w-72 shrink-0 flex-col border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 md:flex">
        <div className="border-b border-slate-200 p-3 dark:border-slate-800">
          <Link href="/docs" className="mb-3 block text-sm font-semibold text-slate-900 dark:text-slate-100">
            {t('title')}
          </Link>
          {search}
          {treeControls}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">{renderArticleTree()}</div>
      </nav>

      <details className="group shrink-0 border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 md:hidden">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-semibold text-slate-900 dark:text-slate-100">
          <span className="flex items-center gap-2">
            <BookOpen className="h-4 w-4 text-teal-600 dark:text-teal-400" aria-hidden />
            {t('browseMenu')}
          </span>
          <ChevronDown className="h-4 w-4 text-slate-400 transition-transform group-open:rotate-180" aria-hidden />
        </summary>
        <div className="border-t border-slate-200 p-3 dark:border-slate-800">
          {search}
          {treeControls}
          <nav className="mt-3 max-h-[55vh] overflow-y-auto">{renderArticleTree()}</nav>
        </div>
      </details>
    </>
  )
}
