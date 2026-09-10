import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../components/viewspec/module-view'
import { categoriesWithArticles, getArticle } from '../../../lib/docs'
import { DocsHome } from './sections'
import { docsHomeSpec, loadDocsHome } from './view'

// Documentation home — hero + a card per category listing its articles.
export default async function DocsHomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  if ((await searchParams).__viewspec === '1') {
    const sp = await searchParams
    const data = await loadDocsHome()
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={docsHomeSpec(data)} data={data} searchParams={sp} trusted />
      </>
    )
  }
  const t = await getTranslations('docs')
  const groups = categoriesWithArticles()
  const startHere = ['welcome', 'quick-start', 'migration-and-cutover']
    .map(getArticle)
    .filter((article): article is NonNullable<typeof article> => Boolean(article))
  const switching = groups.find(({ category }) => category.key === 'switching')?.articles ?? []

  return (
    <DocsHome
      content={{
        eyebrow: t('home.eyebrow'),
        title: t('home.title'),
        subtitle: t('home.subtitle'),
        startHere: t('home.startHere'),
        stepLabels: startHere.map((_, index) => t('home.step', { number: index + 1 })),
        switchingTitle: t('home.switchingTitle'),
        switchingSubtitle: t('home.switchingSubtitle'),
        browseTitle: t('home.browseTitle'),
        browseSubtitle: t('home.browseSubtitle'),
        articleCount: t('home.articleCount', {
          count: groups.reduce((sum, group) => sum + group.articles.length, 0),
        }),
        startHereArticles: startHere,
        switchingShortTitles: switching.map((article) => article.title.replace('Coming from ', '')),
        switchingArticles: switching,
        groups,
      }}
    />
  )
}
