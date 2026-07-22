// Documentation registry — the single source of truth for the in-app help
// center. Register new categories and articles here. Content is bundled into the
// JS output (see ./types.ts for why and for the authoring conventions).

import type { DocArticle, DocCategory, DocSection } from './types'
import { welcome } from './articles/welcome'
import { projectTypes } from './articles/project-types'
import { overheadCosting } from './articles/overhead-costing'
import { laborCosting } from './articles/labor-costing'
import { laborPricing } from './articles/labor-pricing'
import { taxConfiguration } from './articles/tax-configuration'
import { taxJurisdictionsAndNexus, taxReturnsAndBoxes } from './articles/taxes'
import { fieldTickets } from './articles/field-tickets'
import { itemRates } from './articles/item-rates'
import { fixedAssetsDepreciation } from './articles/fixed-assets-depreciation'
import { revenueRecognition } from './articles/revenue-recognition'
import { apps } from './articles/apps'
import { appBuilder } from './articles/app-builder'
import { scriptingEngine, scriptingApiReference } from './articles/scripting'
import { quickBooksDesktopConnector } from './articles/quickbooks-desktop-connector'
import { netSuiteBridge } from './articles/netsuite-bridge'
import { auditLog } from './articles/audit-log'
import { recordCustomization } from './articles/record-customization'
import { customizationArticles } from './articles/customization'
import { platformArticles } from './articles/platform'
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
import { migrateWithAConnector } from './articles/migrate-with-a-connector'
import { companySettings, rolesAndPermissions, dataImports } from './articles/administration-basics'
import { companySetupGroupArticles } from './articles/company-setup'
import { switchingArticles } from './articles/switching'

export type { DocArticle, DocCategory, DocSection } from './types'

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

/**
 * Topic groups are separate from article content so the navigation can be
 * reorganized without changing stable article URLs or touching every article.
 * `parentKey` supports deeper trees when a category eventually needs them.
 */
export const DOC_SECTIONS: DocSection[] = [
  { key: 'getting-started-first-steps', title: 'First Steps', category: 'getting-started', order: 1 },
  { key: 'getting-started-using-openbooks', title: 'Using OpenBooks', category: 'getting-started', order: 2 },
  { key: 'switching-small-business', title: 'Small Business Systems', category: 'switching', order: 1 },
  { key: 'switching-erp', title: 'ERP Systems', category: 'switching', order: 2 },
  { key: 'accounting-ledger', title: 'Ledger Foundations', category: 'accounting', order: 1 },
  { key: 'accounting-master-data', title: 'Master Data', category: 'accounting', order: 2 },
  { key: 'accounting-advanced', title: 'Advanced Accounting', category: 'accounting', order: 3 },
  { key: 'transactions-daily', title: 'Daily Workflows', category: 'transactions', order: 1 },
  { key: 'reporting-guides', title: 'Reports & Insights', category: 'reporting', order: 1 },
  { key: 'integrations-migration', title: 'Migration & Cutover', category: 'integrations', order: 1 },
  { key: 'integrations-connections', title: 'Source Connections', category: 'integrations', order: 2 },
  { key: 'apps-build', title: 'Apps & Scripts', category: 'apps', order: 1 },
  { key: 'apps-automation', title: 'Automation & Integration', category: 'apps', order: 2 },
  { key: 'administration-organization', title: 'Organization & Access', category: 'administration', order: 1 },
  { key: 'administration-company-setup', title: 'Company Setup', category: 'administration', order: 2 },
  { key: 'administration-customize', title: 'Customization', category: 'administration', order: 3 },
  { key: 'administration-taxes', title: 'Taxes', category: 'administration', order: 4 },
  { key: 'administration-data', title: 'Data & Evidence', category: 'administration', order: 5 },
]

const ARTICLE_SECTION_BY_SLUG: Record<string, string> = {
  welcome: 'getting-started-first-steps',
  'quick-start': 'getting-started-first-steps',
  'navigation-and-records': 'getting-started-using-openbooks',
  glossary: 'getting-started-using-openbooks',
  'switching-from-small-business-systems': 'switching-small-business',
  'switching-from-enterprise-systems': 'switching-erp',
  'accounting-model': 'accounting-ledger',
  'transaction-lifecycle': 'accounting-ledger',
  'chart-of-accounts-and-dimensions': 'accounting-ledger',
  'parties-items-and-projects': 'accounting-master-data',
  'revenue-recognition': 'accounting-advanced',
  'fixed-assets-depreciation': 'accounting-advanced',
  'sales-workflow': 'transactions-daily',
  'purchasing-workflow': 'transactions-daily',
  'payments-and-applications': 'transactions-daily',
  'financial-reports': 'reporting-guides',
  'analytics-and-saved-views': 'reporting-guides',
  'migrate-with-a-connector': 'integrations-migration',
  'migration-and-cutover': 'integrations-migration',
  'reconciliation-before-cutover': 'integrations-migration',
  'quickbooks-desktop-connector': 'integrations-connections',
  'netsuite-extraction-bridge': 'integrations-connections',
  'company-settings': 'administration-company-setup',
  'setup-company-group': 'administration-company-setup',
  'setup-accounting-group': 'administration-company-setup',
  'setup-taxes-group': 'administration-company-setup',
  'setup-dimensions-group': 'administration-company-setup',
  'setup-billing-group': 'administration-company-setup',
  'setup-revenue-group': 'administration-company-setup',
  'setup-workforce-group': 'administration-company-setup',
  'setup-assets-group': 'administration-company-setup',
  'setup-currency-group': 'administration-company-setup',
  'setup-projects-group': 'administration-company-setup',
  'tax-jurisdictions-and-nexus': 'administration-taxes',
  'tax-configuration': 'administration-taxes',
  'tax-returns-and-boxes': 'administration-taxes',
  'roles-and-permissions': 'administration-organization',
  'data-imports': 'administration-data',
  'audit-log': 'administration-data',
  'file-cabinet': 'administration-data',
  'record-customization': 'administration-customize',
  'custom-records': 'administration-customize',
  'custom-fields': 'administration-customize',
  'pdf-templates': 'administration-customize',
  'navigation-customization': 'administration-customize',
  apps: 'apps-build',
  'app-builder': 'apps-build',
  'scripting-engine': 'apps-build',
  'scripting-api-reference': 'apps-build',
  flows: 'apps-automation',
  'query-console': 'apps-automation',
  'rest-api': 'apps-automation',
  sandboxes: 'apps-automation',
}

const RAW_DOC_ARTICLES: DocArticle[] = [
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
  fixedAssetsDepreciation,
  salesWorkflow,
  purchasingWorkflow,
  paymentsAndApplications,
  bankingAndReconciliation,
  periodClose,
  projectTypes, overheadCosting, laborCosting, laborPricing, fieldTickets,
  itemRates,
  financialReports,
  analyticsAndSavedViews,
  migrateWithAConnector,
  migrationAndCutover,
  reconciliationBeforeCutover,
  quickBooksDesktopConnector,
  netSuiteBridge,
  apps,
  appBuilder,
  scriptingEngine,
  scriptingApiReference,
  ...platformArticles,
  companySettings,
  ...companySetupGroupArticles,
  taxJurisdictionsAndNexus,
  taxConfiguration,
  taxReturnsAndBoxes,
  rolesAndPermissions,
  recordCustomization,
  ...customizationArticles,
  dataImports,
  auditLog,
  fileCabinet,
]

export const DOC_ARTICLES: DocArticle[] = RAW_DOC_ARTICLES.map((article) => {
  const section = ARTICLE_SECTION_BY_SLUG[article.slug]
  return section ? { ...article, section } : article
})

const BY_SLUG = new Map(DOC_ARTICLES.map((a) => [a.slug, a]))
const CATEGORY_BY_KEY = new Map(DOC_CATEGORIES.map((c) => [c.key, c]))

export function getArticle(slug: string): DocArticle | undefined {
  return BY_SLUG.get(slug)
}

export function getCategory(key: string): DocCategory | undefined {
  return CATEGORY_BY_KEY.get(key)
}

function orderedSections(categoryKey: string, parentKey?: string): DocSection[] {
  return DOC_SECTIONS.filter(
    (section) => section.category === categoryKey && section.parentKey === parentKey,
  ).sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
}

function orderedSectionArticles(categoryKey: string, section: DocSection): DocArticle[] {
  const own = DOC_ARTICLES.filter(
    (article) => article.category === categoryKey && article.section === section.key,
  ).sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
  const children = orderedSections(categoryKey, section.key).flatMap((child) =>
    orderedSectionArticles(categoryKey, child),
  )
  return [...own, ...children]
}

/** Categories in display order, each with articles in visible tree order. */
export function categoriesWithArticles(): Array<{
  category: DocCategory
  articles: DocArticle[]
}> {
  return [...DOC_CATEGORIES]
    .sort((a, b) => a.order - b.order)
    .map((category) => ({
      category,
      articles: [
        ...DOC_ARTICLES.filter((article) => article.category === category.key && !article.section).sort(
          (a, b) => a.order - b.order || a.title.localeCompare(b.title),
        ),
        ...orderedSections(category.key).flatMap((section) => orderedSectionArticles(category.key, section)),
      ],
    }))
    .filter((group) => group.articles.length > 0)
}

/** Lightweight nav/search index (no bodies) safe to pass to client components. */
export interface DocNavArticle {
  slug: string
  title: string
  category: string
  section?: string
  summary: string
  keywords: string[]
  /** Lowercased article body for full-text sidebar search. */
  text: string
}

export function docNavIndex(): {
  categories: DocCategory[]
  sections: DocSection[]
  articles: DocNavArticle[]
} {
  const groups = categoriesWithArticles()
  return {
    categories: groups.map(({ category }) => category),
    sections: [...DOC_SECTIONS].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title)),
    articles: groups.flatMap(({ articles }) =>
      articles.map((a) => ({
        slug: a.slug,
        title: a.title,
        category: a.category,
        ...(a.section ? { section: a.section } : {}),
        summary: a.summary,
        keywords: a.keywords ?? [],
        text: a.body.toLowerCase(),
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
