import Link from 'next/link'
import { ArrowLeft, ArrowRight, ChevronRight } from 'lucide-react'

import { ChatMarkdown } from '../../../../components/assistant/markdown'

export interface DocArticleLink {
  slug: string
  title: string
}

export interface DocArticleContent {
  breadcrumbLabel: string
  breadcrumbTitle: string
  categoryTitle: string | null
  /** Raw Markdown; the component renders it (never pre-rendered in the loader). */
  body: string
  /** Fully formatted `docs.lastUpdated` string (loader runs `t`). */
  lastUpdated: string
  relatedTitle: string
  related: DocArticleLink[]
  articleNavLabel: string
  previous: DocArticleLink | null
  next: DocArticleLink | null
  previousLabel: string
  nextLabel: string
}

/**
 * Documentation article — breadcrumb, Markdown body, related links, prev/next.
 *
 * Shared by the native page and the ViewSpec `doc-article` widget (the brief's
 * "move it here and import it back" rule): one implementation, two render
 * paths. The conditional PAIRS (category span, related block, adjacent nav,
 * prev/next cards) stay here because a spec has presence, not branching — the
 * same doctrine as the docs home (`docs-home`): decomposing styled composite
 * cards into generic blocks would reimplement the component, not compose it.
 */
export function DocArticleView({ content }: { content: DocArticleContent }) {
  return (
    <article className="mx-auto max-w-3xl px-6 py-10">
      <nav
        className="mb-4 flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400"
        aria-label={content.breadcrumbLabel}
      >
        <Link href="/docs" className="hover:text-slate-700 dark:hover:text-slate-200">
          {content.breadcrumbTitle}
        </Link>
        {content.categoryTitle ? (
          <>
            <ChevronRight className="h-3 w-3" aria-hidden />
            <span>{content.categoryTitle}</span>
          </>
        ) : null}
      </nav>

      <ChatMarkdown className="prose-base">{content.body}</ChatMarkdown>

      <p className="mt-8 border-t border-slate-200 pt-4 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
        {content.lastUpdated}
      </p>

      {content.related.length > 0 ? (
        <div className="mt-6">
          <h2 className="mb-2 text-sm font-semibold text-slate-900 dark:text-slate-100">{content.relatedTitle}</h2>
          <ul className="space-y-1">
            {content.related.map((r) => (
              <li key={r.slug}>
                <Link
                  href={`/docs/${r.slug}`}
                  className="text-sm font-medium text-teal-700 hover:underline dark:text-teal-300"
                >
                  {r.title}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {content.previous || content.next ? (
        <nav
          className="mt-8 grid gap-3 border-t border-slate-200 pt-6 sm:grid-cols-2 dark:border-slate-800"
          aria-label={content.articleNavLabel}
        >
          {content.previous ? (
            <Link
              href={`/docs/${content.previous.slug}`}
              className="group rounded-lg border border-slate-200 p-3 hover:border-teal-300 dark:border-slate-800 dark:hover:border-teal-800"
            >
              <span className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
                <ArrowLeft className="h-3.5 w-3.5 transition-transform group-hover:-translate-x-0.5" aria-hidden />
                {content.previousLabel}
              </span>
              <span className="mt-1 block text-sm font-medium text-slate-900 dark:text-slate-100">
                {content.previous.title}
              </span>
            </Link>
          ) : (
            <span />
          )}
          {content.next ? (
            <Link
              href={`/docs/${content.next.slug}`}
              className="group rounded-lg border border-slate-200 p-3 text-right hover:border-teal-300 dark:border-slate-800 dark:hover:border-teal-800"
            >
              <span className="flex items-center justify-end gap-1 text-xs text-slate-500 dark:text-slate-400">
                {content.nextLabel}
                <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden />
              </span>
              <span className="mt-1 block text-sm font-medium text-slate-900 dark:text-slate-100">
                {content.next.title}
              </span>
            </Link>
          ) : null}
        </nav>
      ) : null}
    </article>
  )
}
