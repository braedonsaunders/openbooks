// Documentation registry — the single source of truth for the in-app help
// center. Register new categories and articles here. Content is bundled into the
// JS output (see ./types.ts for why and for the authoring conventions).

import type { DocArticle, DocCategory } from './types'
import { welcome } from './articles/welcome'
import { projectTypes } from './articles/project-types'

export type { DocArticle, DocCategory } from './types'

export const DOC_CATEGORIES: DocCategory[] = [
  {
    key: 'getting-started',
    title: 'Getting Started',
    description: 'Orientation and the core concepts behind OpenBooks.',
    icon: 'book',
    order: 1,
  },
  {
    key: 'projects',
    title: 'Projects & Billing',
    description: 'Project types, profitability, invoicing, and invoice backup.',
    icon: 'timer',
    order: 2,
  },
]

export const DOC_ARTICLES: DocArticle[] = [welcome, projectTypes]

const BY_SLUG = new Map(DOC_ARTICLES.map((a) => [a.slug, a]))
const CATEGORY_BY_KEY = new Map(DOC_CATEGORIES.map((c) => [c.key, c]))

export function getArticle(slug: string): DocArticle | undefined {
  return BY_SLUG.get(slug)
}

export function getCategory(key: string): DocCategory | undefined {
  return CATEGORY_BY_KEY.get(key)
}

/** Categories in display order, each with its articles (article order asc). */
export function categoriesWithArticles(): Array<{ category: DocCategory; articles: DocArticle[] }> {
  return [...DOC_CATEGORIES]
    .sort((a, b) => a.order - b.order)
    .map((category) => ({
      category,
      articles: DOC_ARTICLES.filter((a) => a.category === category.key).sort((a, b) => a.order - b.order),
    }))
    .filter((group) => group.articles.length > 0)
}

/** Lightweight nav/search index (no bodies) safe to pass to client components. */
export interface DocNavArticle {
  slug: string
  title: string
  category: string
  summary: string
  keywords: string[]
}

export function docNavIndex(): { categories: DocCategory[]; articles: DocNavArticle[] } {
  return {
    categories: [...DOC_CATEGORIES].sort((a, b) => a.order - b.order),
    articles: DOC_ARTICLES.map((a) => ({
      slug: a.slug,
      title: a.title,
      category: a.category,
      summary: a.summary,
      keywords: a.keywords ?? [],
    })),
  }
}
