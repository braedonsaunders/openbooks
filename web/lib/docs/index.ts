// Documentation registry — the single source of truth for the in-app help
// center. Register new categories and articles here. Content is bundled into the
// JS output (see ./types.ts for why and for the authoring conventions).

import type { DocArticle, DocCategory } from './types'
import { welcome } from './articles/welcome'
import { projectTypes } from './articles/project-types'
import { revenueRecognition } from './articles/revenue-recognition'
import { apps } from './articles/apps'
import { quickBooksDesktopConnector } from './articles/quickbooks-desktop-connector'
import { auditLog } from './articles/audit-log'
import { quickStart, navigationAndRecords, glossary } from './articles/getting-started'
import {
  accountingModel,
  transactionLifecycle,
  chartOfAccountsAndDimensions,
  partiesItemsAndProjects,
} from './articles/accounting-basics'
import {
  salesWorkflow,
  purchasingWorkflow,
  paymentsAndApplications,
  bankingAndReconciliation,
  fileCabinet,
} from './articles/daily-workflows'
import { financialReports, analyticsAndSavedViews, periodClose } from './articles/reporting-close'
import { migrationAndCutover, reconciliationBeforeCutover } from './articles/migration'
import { companySettings, rolesAndPermissions, dataImports } from './articles/administration-basics'
import { switchingArticles } from './articles/switching'

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
    key: 'switching',
    title: 'Switching to OpenBooks',
    description: 'Familiarization guides for teams moving from another accounting system.',
    icon: 'shuffle',
    order: 2,
  },
  {
    key: 'accounting',
    title: 'Accounting Foundations',
    description: 'The ledger model, transaction lifecycle, accounts, dimensions, and master data.',
    icon: 'journal',
    order: 3,
  },
  {
    key: 'transactions',
    title: 'Sales & Purchases',
    description: 'Customer and vendor transaction lifecycles, payments, credits, and applications.',
    icon: 'clipboard',
    order: 4,
  },
  {
    key: 'banking-close',
    title: 'Banking & Close',
    description: 'Statement matching, reconciliation, evidence, and the governed period close.',
    icon: 'building',
    order: 5,
  },
  {
    key: 'projects',
    title: 'Projects & Billing',
    description: 'Project types, profitability, invoicing, and invoice backup.',
    icon: 'timer',
    order: 6,
  },
  {
    key: 'reporting',
    title: 'Reporting & Analytics',
    description: 'Financial statements, ledger detail, dashboards, analytics, and reusable views.',
    icon: 'file',
    order: 7,
  },
  {
    key: 'integrations',
    title: 'Integrations & Migration',
    description: 'Plan cutover, prove migrated books, and operate tenant-scoped source connections.',
    icon: 'plug',
    order: 8,
  },
  {
    key: 'apps',
    title: 'Apps & Extensions',
    description: 'Install, use, update, and administer organization extensions.',
    icon: 'grid',
    order: 9,
  },
  {
    key: 'administration',
    title: 'Administration',
    description: 'Configuration, permissions, imports, files, security, and immutable evidence.',
    icon: 'shield',
    order: 10,
  },
]

export const DOC_ARTICLES: DocArticle[] = [
  welcome,
  quickStart,
  navigationAndRecords,
  glossary,
  ...switchingArticles,
  accountingModel,
  transactionLifecycle,
  chartOfAccountsAndDimensions,
  partiesItemsAndProjects,
  revenueRecognition,
  salesWorkflow,
  purchasingWorkflow,
  paymentsAndApplications,
  bankingAndReconciliation,
  periodClose,
  projectTypes,
  financialReports,
  analyticsAndSavedViews,
  migrationAndCutover,
  reconciliationBeforeCutover,
  quickBooksDesktopConnector,
  apps,
  companySettings,
  rolesAndPermissions,
  dataImports,
  auditLog,
  fileCabinet,
]

const BY_SLUG = new Map(DOC_ARTICLES.map((a) => [a.slug, a]))
const CATEGORY_BY_KEY = new Map(DOC_CATEGORIES.map((c) => [c.key, c]))

export function getArticle(slug: string): DocArticle | undefined {
  return BY_SLUG.get(slug)
}

export function getCategory(key: string): DocCategory | undefined {
  return CATEGORY_BY_KEY.get(key)
}

/** Categories in display order, each with its articles (article order asc). */
export function categoriesWithArticles(): Array<{
  category: DocCategory
  articles: DocArticle[]
}> {
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

export function docNavIndex(): {
  categories: DocCategory[]
  articles: DocNavArticle[]
} {
  const groups = categoriesWithArticles()
  return {
    categories: groups.map(({ category }) => category),
    articles: groups.flatMap(({ articles }) =>
      articles.map((a) => ({
        slug: a.slug,
        title: a.title,
        category: a.category,
        summary: a.summary,
        keywords: a.keywords ?? [],
      })),
    ),
  }
}

/** Previous and next articles in the documentation's visible reading order. */
export function adjacentArticles(slug: string): {
  previous?: DocArticle
  next?: DocArticle
} {
  const ordered = categoriesWithArticles().flatMap(({ articles }) => articles)
  const index = ordered.findIndex((article) => article.slug === slug)
  if (index < 0) return {}
  const previous = ordered[index - 1]
  const next = ordered[index + 1]
  return {
    ...(previous ? { previous } : {}),
    ...(next ? { next } : {}),
  }
}
