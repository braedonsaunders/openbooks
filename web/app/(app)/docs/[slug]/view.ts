import 'server-only'

import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { page, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { adjacentArticles, getArticle, getCategory } from '../../../../lib/docs'
import type { DocArticleContent } from './sections'

/**
 * Documentation article, split into a loader and a spec.
 *
 * The page has no DB reads, no permission gates and no query params: its
 * content is the static docs registry plus `docs.*` strings. Loader work
 * copied verbatim from page.tsx: the `getArticle` guard (`notFound` for an
 * unknown slug), the `getCategory` lookup, the `related` resolution (unknown
 * related slugs filtered, exactly as the native page does), and the adjacent
 * prev/next pair.
 *
 * The body is raw Markdown passed through to the `doc-article` widget: the
 * native page renders it client-side with ChatMarkdown (react-markdown), so
 * the loader must NOT pre-render or format it — same rule as a
 * browser-locale date. `t('lastUpdated', { date })` runs in the loader in
 * both paths (a spec carries no function values).
 *
 * No slots: nothing here needs an Authz, an org id or a user id. Same
 * whole-component doctrine as the docs home (`docs-home`): the page is
 * conditional pairs (category span, related block, adjacent nav) and styled
 * composite cards (prev/next links with lucide icons) that generic
 * vocabulary cannot name without NEW language (coordinator-owned). Icons
 * alone (`ChevronRight`, `ArrowLeft`, `ArrowRight` via lucide) force a
 * widget — specs name no components.
 */

export interface DocArticleData {
  content: DocArticleContent
}

export async function loadDocArticle(slug: string): Promise<DocArticleData> {
  const article = getArticle(slug)
  if (!article) notFound()

  const t = await getTranslations('docs')
  const category = getCategory(article.category)
  const related = (article.related ?? []).map(getArticle).filter((a): a is NonNullable<typeof a> => Boolean(a))
  const adjacent = adjacentArticles(article.slug)

  return {
    content: {
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
    },
  }
}

export function docArticleSpec(data: DocArticleData): PageSpec {
  return page({
    route: '/docs/[slug]',
    // The article owns its own centered container; a list layout would nest
    // it in a second shell (same reason as the docs home).
    layout: 'bare',
    header: [],
    body: [
      widgetBlock('doc-article', {
        content: data.content,
      }),
    ],
  })
}
