import type { Metadata } from 'next'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { getArticle, DOC_ARTICLES } from '../../../../lib/docs'
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
  const sp = await searchParams
  const data = await loadDocArticle((await params).slug)
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={docArticleSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}
