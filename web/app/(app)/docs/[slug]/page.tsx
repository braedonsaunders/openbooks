import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { adjacentArticles, getArticle, getCategory, DOC_ARTICLES } from '../../../../lib/docs'
import { DocArticleView } from './sections'
import { docArticleSpec, loadDocArticle } from './view'

// Pre-render every article at build time (content is static + bundled).
export function generateStaticParams() {
  return DOC_ARTICLES.map((a) => ({ slug: a.slug }))
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const article = getArticle((await params).slug)
  return article ? { title: article.title, description: article.summary } : {}
}

export default async function DocArticlePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  if ((await searchParams).__viewspec === '1') {
    const sp = await searchParams
    const data = await loadDocArticle((await params).slug)
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={docArticleSpec(data)} data={data} searchParams={sp} trusted />
      </>
    )
  }
  const { slug } = await params
  const article = getArticle(slug)
  if (!article) notFound()

  const t = await getTranslations('docs')
  const category = getCategory(article.category)
  const related = (article.related ?? []).map(getArticle).filter((a): a is NonNullable<typeof a> => Boolean(a))
  const adjacent = adjacentArticles(article.slug)

  return (
    <DocArticleView
      content={{
        breadcrumbLabel: t('breadcrumb'),
        breadcrumbTitle: t('title'),
        categoryTitle: category ? category.title : null,
        body: article.body,
        lastUpdated: t('lastUpdated', { date: article.updated }),
        relatedTitle: t('related'),
        related: related.map((r) => ({ slug: r.slug, title: r.title })),
        articleNavLabel: t('articleNavigation'),
        previous: adjacent.previous ? { slug: adjacent.previous.slug, title: adjacent.previous.title } : null,
        next: adjacent.next ? { slug: adjacent.next.slug, title: adjacent.next.title } : null,
        previousLabel: t('previous'),
        nextLabel: t('next'),
      }}
    />
  )
}
