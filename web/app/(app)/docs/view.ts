import 'server-only'

import { getTranslations } from 'next-intl/server'
import { page, ref, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { categoriesWithArticles, getArticle } from '../../../lib/docs'
import type { DocsHomeContent } from './sections'

/**
 * Documentation home, split into a loader and a spec.
 *
 * The page has no DB reads, no permission gates and no query params: its
 * content is the static docs registry plus `docs.home.*` strings. Its markup
 * is bespoke throughout — a gradient hero, lucide icons, composite link
 * cards — so the spec places the whole body through one `docs-home` widget,
 * the same doctrine as the reports hub (`reports-hub`) and the analytics
 * hub (`analytics-hub`): decomposing styled composite cards into generic
 * blocks would reimplement the component, not compose it.
 *
 * Loader work copied verbatim from page.tsx: the start-here slugs, the
 * `getArticle` guard, the switching-group lookup, and the "Coming from "
 * prefix strip on the switching pills. The `step` label and the pluralized
 * article count are formatted here (a spec carries no function values).
 */

export interface DocsData {
  content: DocsHomeContent
}

export async function loadDocsHome(): Promise<DocsData> {
  const t = await getTranslations('docs')
  const groups = categoriesWithArticles()
  const startHere = ['welcome', 'quick-start', 'migration-and-cutover']
    .map(getArticle)
    .filter((article): article is NonNullable<typeof article> => Boolean(article))
  const switching = groups.find(({ category }) => category.key === 'switching')?.articles ?? []

  return {
    content: {
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
    },
  }
}

const f = ref<DocsData>()

export function docsHomeSpec(data: DocsData): PageSpec {
  return page({
    route: '/docs',
    // The docs home owns its own centered container; a list layout would
    // nest it in a second shell.
    layout: 'bare',
    header: [],
    body: [
      widgetBlock('docs-home', {
        content: data.content,
      }),
    ],
  })
}
