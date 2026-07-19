import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { ChevronRight } from 'lucide-react'
import { ChatMarkdown } from '../../../../components/assistant/markdown'
import { getArticle, getCategory, DOC_ARTICLES } from '../../../../lib/docs'

// Pre-render every article at build time (content is static + bundled).
export function generateStaticParams() {
  return DOC_ARTICLES.map((a) => ({ slug: a.slug }))
}

export default async function DocArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const article = getArticle(slug)
  if (!article) notFound()

  const t = await getTranslations('docs')
  const category = getCategory(article.category)
  const related = (article.related ?? []).map(getArticle).filter((a): a is NonNullable<typeof a> => Boolean(a))

  return (
    <article className="mx-auto max-w-3xl px-6 py-10">
      <nav className="mb-4 flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400" aria-label="Breadcrumb">
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
                <Link href={`/docs/${r.slug}`} className="text-sm font-medium text-teal-700 hover:underline dark:text-teal-300">
                  {r.title}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </article>
  )
}
