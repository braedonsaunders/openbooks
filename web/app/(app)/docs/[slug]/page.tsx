import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { ArrowLeft, ArrowRight, ChevronRight } from 'lucide-react'
import { ChatMarkdown } from '../../../../components/assistant/markdown'
import { adjacentArticles, getArticle, getCategory, DOC_ARTICLES } from '../../../../lib/docs'

// Pre-render every article at build time (content is static + bundled).
export function generateStaticParams() {
  return DOC_ARTICLES.map((a) => ({ slug: a.slug }))
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const article = getArticle((await params).slug)
  return article ? { title: article.title, description: article.summary } : {}
}

export default async function DocArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const article = getArticle(slug)
  if (!article) notFound()

  const t = await getTranslations('docs')
  const category = getCategory(article.category)
  const related = (article.related ?? []).map(getArticle).filter((a): a is NonNullable<typeof a> => Boolean(a))
  const adjacent = adjacentArticles(article.slug)

  return (
    <article className="mx-auto max-w-3xl px-6 py-10">
      <nav
        className="mb-4 flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400"
        aria-label={t('breadcrumb')}
      >
        <Link href="/docs" className="hover:text-slate-700 dark:hover:text-slate-200">
          {t('title')}
        </Link>
        {category ? (
          <>
            <ChevronRight className="h-3 w-3" aria-hidden />
            <span>{category.title}</span>
          </>
        ) : null}
      </nav>

      <ChatMarkdown className="prose-base">{article.body}</ChatMarkdown>

      <p className="mt-8 border-t border-slate-200 pt-4 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
        {t('lastUpdated', { date: article.updated })}
      </p>

      {related.length > 0 ? (
        <div className="mt-6">
          <h2 className="mb-2 text-sm font-semibold text-slate-900 dark:text-slate-100">{t('related')}</h2>
          <ul className="space-y-1">
            {related.map((r) => (
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

      {adjacent.previous || adjacent.next ? (
        <nav
          className="mt-8 grid gap-3 border-t border-slate-200 pt-6 sm:grid-cols-2 dark:border-slate-800"
          aria-label={t('articleNavigation')}
        >
          {adjacent.previous ? (
            <Link
              href={`/docs/${adjacent.previous.slug}`}
              className="group rounded-lg border border-slate-200 p-3 hover:border-teal-300 dark:border-slate-800 dark:hover:border-teal-800"
            >
              <span className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
                <ArrowLeft className="h-3.5 w-3.5 transition-transform group-hover:-translate-x-0.5" aria-hidden />
                {t('previous')}
              </span>
              <span className="mt-1 block text-sm font-medium text-slate-900 dark:text-slate-100">
                {adjacent.previous.title}
              </span>
            </Link>
          ) : (
            <span />
          )}
          {adjacent.next ? (
            <Link
              href={`/docs/${adjacent.next.slug}`}
              className="group rounded-lg border border-slate-200 p-3 text-right hover:border-teal-300 dark:border-slate-800 dark:hover:border-teal-800"
            >
              <span className="flex items-center justify-end gap-1 text-xs text-slate-500 dark:text-slate-400">
                {t('next')}
                <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden />
              </span>
              <span className="mt-1 block text-sm font-medium text-slate-900 dark:text-slate-100">
                {adjacent.next.title}
              </span>
            </Link>
          ) : null}
        </nav>
      ) : null}
    </article>
  )
}
