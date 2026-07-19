import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { ArrowRight } from 'lucide-react'
import { categoriesWithArticles } from '../../../lib/docs'

// Documentation home — hero + a card per category listing its articles.
export default async function DocsHomePage() {
  const t = await getTranslations('docs')
  const groups = categoriesWithArticles()

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">{t('home.title')}</h1>
        <p className="mt-2 max-w-2xl text-sm text-slate-600 dark:text-slate-400">{t('home.subtitle')}</p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        {groups.map(({ category, articles }) => (
          <section
            key={category.key}
            className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
          >
            <h2 className="mb-1 text-sm font-semibold text-slate-900 dark:text-slate-100">{category.title}</h2>
            <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">{category.description}</p>
            <ul className="space-y-1">
              {articles.map((a) => (
                <li key={a.slug}>
                  <Link
                    href={`/docs/${a.slug}`}
                    className="group flex items-center gap-1.5 text-sm font-medium text-teal-700 hover:underline dark:text-teal-300"
                  >
                    {a.title}
                    <ArrowRight className="h-3.5 w-3.5 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
                  </Link>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{a.summary}</p>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}
