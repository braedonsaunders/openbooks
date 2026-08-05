import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { ArrowRight, BookOpenCheck, Compass, Replace } from 'lucide-react'
import { categoriesWithArticles, getArticle } from '../../../lib/docs'

// Documentation home — hero + a card per category listing its articles.
export default async function DocsHomePage() {
  const t = await getTranslations('docs')
  const groups = categoriesWithArticles()
  const startHere = ['welcome', 'quick-start', 'migration-and-cutover']
    .map(getArticle)
    .filter((article): article is NonNullable<typeof article> => Boolean(article))
  const switching = groups.find(({ category }) => category.key === 'switching')?.articles ?? []

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-10">
      <header className="mb-8 rounded-xl border border-teal-200 bg-gradient-to-br from-teal-50 to-white p-6 dark:border-teal-900 dark:from-teal-950/40 dark:to-slate-950">
        <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-teal-600 text-white dark:bg-teal-500 dark:text-slate-950">
          <BookOpenCheck className="h-5 w-5" aria-hidden />
        </div>
        <p className="text-xs font-semibold uppercase tracking-wider text-teal-700 dark:text-teal-300">
          {t('home.eyebrow')}
        </p>
        <h1 className="mt-1 text-2xl font-semibold text-slate-900 dark:text-slate-100 sm:text-3xl">
          {t('home.title')}
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600 dark:text-slate-300">{t('home.subtitle')}</p>
      </header>

      <section className="mb-8" aria-labelledby="start-here-heading">
        <div className="mb-3 flex items-center gap-2">
          <Compass className="h-4 w-4 text-teal-600 dark:text-teal-400" aria-hidden />
          <h2 id="start-here-heading" className="text-base font-semibold text-slate-900 dark:text-slate-100">
            {t('home.startHere')}
          </h2>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          {startHere.map((article, index) => (
            <Link
              key={article.slug}
              href={`/docs/${article.slug}`}
              className="group rounded-lg border border-slate-200 bg-white p-4 transition-colors hover:border-teal-300 hover:bg-teal-50/40 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-teal-800 dark:hover:bg-teal-950/20"
            >
              <span className="text-xs font-semibold text-teal-700 dark:text-teal-300">
                {t('home.step', { number: index + 1 })}
              </span>
              <span className="mt-1 flex items-center justify-between gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                {article.title}
                <ArrowRight
                  className="h-4 w-4 shrink-0 text-slate-400 transition-transform group-hover:translate-x-0.5 group-hover:text-teal-600"
                  aria-hidden
                />
              </span>
              <span className="mt-1 block text-xs leading-5 text-slate-500 dark:text-slate-400">{article.summary}</span>
            </Link>
          ))}
        </div>
      </section>

      <section
        className="mb-8 rounded-lg border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-900/60"
        aria-labelledby="switching-heading"
      >
        <div className="mb-3 flex items-start gap-2">
          <Replace className="mt-0.5 h-4 w-4 text-violet-600 dark:text-violet-400" aria-hidden />
          <div>
            <h2 id="switching-heading" className="text-base font-semibold text-slate-900 dark:text-slate-100">
              {t('home.switchingTitle')}
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">{t('home.switchingSubtitle')}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {switching.map((article) => (
            <Link
              key={article.slug}
              href={`/docs/${article.slug}`}
              className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-violet-300 hover:text-violet-700 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300 dark:hover:border-violet-700 dark:hover:text-violet-300"
            >
              {article.title.replace('Coming from ', '')}
            </Link>
          ))}
        </div>
      </section>

      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">{t('home.browseTitle')}</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">{t('home.browseSubtitle')}</p>
        </div>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {t('home.articleCount', {
            count: groups.reduce((sum, group) => sum + group.articles.length, 0),
          })}
        </span>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {groups.map(({ category, articles }) => (
          <section
            key={category.key}
            id={category.key}
            className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
          >
            <div className="mb-1 flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{category.title}</h3>
              <span className="text-[11px] tabular-nums text-slate-400 dark:text-slate-500">{articles.length}</span>
            </div>
            <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">{category.description}</p>
            <ul className="space-y-1">
              {articles.map((a) => (
                <li key={a.slug}>
                  <Link
                    href={`/docs/${a.slug}`}
                    className="group flex items-center gap-1.5 text-sm font-medium text-teal-700 hover:underline dark:text-teal-300"
                  >
                    {a.title}
                    <ArrowRight
                      className="h-3.5 w-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                      aria-hidden
                    />
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
