// Documentation registry — the single source of truth for the in-app help
// center. Register new categories and articles here. Content is bundled into the
// JS output (see ./types.ts for why and for the authoring conventions).

import type { DocArticle, DocCategory, DocSection } from './types'
import { allocations } from './articles/allocations'
import { welcome } from './articles/welcome'
import { projectTypes } from './articles/project-types'
import { overheadCosting } from './articles/overhead-costing'
import { laborCosting } from './articles/labor-costing'
import { laborPricing } from './articles/labor-pricing'
import { hrmProcesses } from './articles/hrm-processes'
// HR-15: inbox and persona homes article.
import { inboxAndHome } from './articles/inbox-and-home'
// HR-16 begin
import { automations } from './articles/automations'
import { correctingAndRescinding } from './articles/correcting-and-rescinding'
// HR-16 end
import { performanceAndRetention } from './articles/performance-and-retention'
// HR-17 begin: continuous-performance article.
import { continuousPerformance } from './articles/continuous-performance'
// HR-17 end
import { selfService } from './articles/self-service'
import { payroll } from './articles/payroll'
import { employmentMigration } from './articles/employment-migration'
import { positionsAndHeadcount } from './articles/positions-and-headcount'
import { leaveTimeVersusValue } from './articles/leave-time-versus-value'
import { recruitingFunnel } from './articles/recruiting-funnel'
import { benefitsEnrollment } from './articles/benefits-enrollment'
// HR-13 begin: construction-compliance article.
import { certifiedPayrollPrevailingWagePerDiem } from './articles/certified-payroll-prevailing-wage-per-diem'
// HR-13 end
// HR-20 begin: field-time articles.
import { fieldClockIn } from './articles/field-clock-in'
import { crewTimeEntry } from './articles/crew-time-entry'
// HR-20 end
import { compensationAndTransparency } from './articles/compensation-transparency'
// HR-14 begin: certifications, licenses, and dispatch gating article.
import { certificationsLicensesDispatch } from './articles/certifications-licenses-dispatch'
import { payslipExplanations } from './articles/payslip-explanations'
import { payrollChecks } from './articles/payroll-checks'
import { aiGovernanceLedger } from './articles/ai-governance-ledger'
// HR-14 end
// HR-19 begin: documents/signatures/retention, engagement surveys, and org
// chart articles.
import { documentsSignaturesAndRetention } from './articles/documents-signatures-and-retention'
import { engagementSurveys } from './articles/engagement-surveys'
import { orgChartAndDirectory } from './articles/org-chart-and-directory'
// HR-19 end
// HR-18 begin: structured interviews, offers and job boards article.
import { structuredInterviewsOffersJobBoards } from './articles/structured-interviews-offers-job-boards'
// HR-18 end
import { taxConfiguration } from './articles/tax-configuration'
import { taxJurisdictionsAndNexus, taxReturnsAndBoxes } from './articles/taxes'
import { fieldTickets } from './articles/field-tickets'
import { subcontractorCompliance } from './articles/subcontractor-compliance'
import { itemRates } from './articles/item-rates'
import { fixedAssetsDepreciation } from './articles/fixed-assets-depreciation'
import { revenueRecognition } from './articles/revenue-recognition'
import { propertyManagement } from './articles/property-management'
import { extensions } from './articles/extensions'
import { apps } from './articles/apps'
import { appBuilder } from './articles/app-builder'
import { appApiReference } from './articles/app-api-reference'
import { appAssistantTools } from './articles/app-assistant-tools'
import { mcpControl } from './articles/mcp-control'
import { scriptingEngine, scriptingApiReference } from './articles/scripting'
import { quickBooksDesktopConnector } from './articles/quickbooks-desktop-connector'
import { netSuiteBridge } from './articles/netsuite-bridge'
import { auditLog } from './articles/audit-log'
import { issueReporting } from './articles/issue-reporting'
import { recordCustomization } from './articles/record-customization'
import { customizationArticles } from './articles/customization'
import { platformArticles } from './articles/platform'
import { quickStart, navigationAndRecords, glossary } from './articles/getting-started'
import { assistantChat } from './articles/assistant-chat'
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
import { agentWorkbench } from './articles/agent-workbench'
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
    titleKey: 'categories.getting-started.title',
    description: 'Orientation and the core concepts behind OpenBooks.',
    descriptionKey: 'categories.getting-started.description',
    icon: 'book',
    order: 1,
  },
  {
    key: 'switching',
    title: 'Switching to OpenBooks',
    titleKey: 'categories.switching.title',
    description: 'Familiarization guides for teams moving from another accounting system.',
    descriptionKey: 'categories.switching.description',
    icon: 'shuffle',
    order: 2,
  },
  {
    key: 'accounting',
    title: 'Accounting Foundations',
    titleKey: 'categories.accounting.title',
    description: 'The ledger model, transaction lifecycle, accounts, dimensions, and master data.',
    descriptionKey: 'categories.accounting.description',
    icon: 'journal',
    order: 3,
  },
  {
    key: 'transactions',
    title: 'Sales & Purchases',
    titleKey: 'categories.transactions.title',
    description: 'Customer and vendor transaction lifecycles, payments, credits, and applications.',
    descriptionKey: 'categories.transactions.description',
    icon: 'clipboard',
    order: 4,
  },
  {
    key: 'banking-close',
    title: 'Banking & Close',
    titleKey: 'categories.banking-close.title',
    description: 'Statement matching, reconciliation, evidence, and the governed period close.',
    descriptionKey: 'categories.banking-close.description',
    icon: 'building',
    order: 5,
  },
  {
    key: 'projects',
    title: 'Projects & Billing',
    titleKey: 'categories.projects.title',
    description: 'Project types, profitability, invoicing, and invoice backup.',
    descriptionKey: 'categories.projects.description',
    icon: 'timer',
    order: 6,
  },
  {
    key: 'reporting',
    title: 'Reporting & Analytics',
    titleKey: 'categories.reporting.title',
    description: 'Financial statements, ledger detail, dashboards, analytics, and reusable views.',
    descriptionKey: 'categories.reporting.description',
    icon: 'file',
    order: 7,
  },
  {
    key: 'integrations',
    title: 'Integrations & Migration',
    titleKey: 'categories.integrations.title',
    description: 'Plan cutover, prove migrated books, and operate tenant-scoped source connections.',
    descriptionKey: 'categories.integrations.description',
    icon: 'plug',
    order: 8,
  },
  {
    key: 'apps',
    title: 'Apps & Extensions',
    titleKey: 'categories.apps.title',
    description: 'Install, use, update, and administer organization extensions.',
    descriptionKey: 'categories.apps.description',
    icon: 'grid',
    order: 9,
  },
  {
    key: 'administration',
    title: 'Administration',
    titleKey: 'categories.administration.title',
    description: 'Configuration, permissions, imports, files, security, and immutable evidence.',
    descriptionKey: 'categories.administration.description',
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
  { key: 'getting-started-first-steps', title: 'First Steps', titleKey: 'sections.getting-started-first-steps.title', category: 'getting-started', order: 1 },
  { key: 'getting-started-using-openbooks', title: 'Using OpenBooks', titleKey: 'sections.getting-started-using-openbooks.title', category: 'getting-started', order: 2 },
  { key: 'switching-small-business', title: 'Small Business Systems', titleKey: 'sections.switching-small-business.title', category: 'switching', order: 1 },
  { key: 'switching-erp', title: 'ERP Systems', titleKey: 'sections.switching-erp.title', category: 'switching', order: 2 },
  { key: 'accounting-ledger', title: 'Ledger Foundations', titleKey: 'sections.accounting-ledger.title', category: 'accounting', order: 1 },
  { key: 'accounting-master-data', title: 'Master Data', titleKey: 'sections.accounting-master-data.title', category: 'accounting', order: 2 },
  { key: 'accounting-advanced', title: 'Advanced Accounting', titleKey: 'sections.accounting-advanced.title', category: 'accounting', order: 3 },
  { key: 'transactions-daily', title: 'Daily Workflows', titleKey: 'sections.transactions-daily.title', category: 'transactions', order: 1 },
  { key: 'reporting-guides', title: 'Reports & Insights', titleKey: 'sections.reporting-guides.title', category: 'reporting', order: 1 },
  { key: 'integrations-migration', title: 'Migration & Cutover', titleKey: 'sections.integrations-migration.title', category: 'integrations', order: 1 },
  { key: 'integrations-connections', title: 'Source Connections', titleKey: 'sections.integrations-connections.title', category: 'integrations', order: 2 },
  { key: 'apps-build', title: 'Apps & Scripts', titleKey: 'sections.apps-build.title', category: 'apps', order: 1 },
  { key: 'apps-automation', title: 'Automation & Integration', titleKey: 'sections.apps-automation.title', category: 'apps', order: 2 },
  { key: 'administration-organization', title: 'Organization & Access', titleKey: 'sections.administration-organization.title', category: 'administration', order: 1 },
  { key: 'administration-company-setup', title: 'Company Setup', titleKey: 'sections.administration-company-setup.title', category: 'administration', order: 2 },
  { key: 'administration-customize', title: 'Customization', titleKey: 'sections.administration-customize.title', category: 'administration', order: 3 },
  { key: 'administration-taxes', title: 'Taxes', titleKey: 'sections.administration-taxes.title', category: 'administration', order: 4 },
  { key: 'administration-data', title: 'Data & Evidence', titleKey: 'sections.administration-data.title', category: 'administration', order: 5 },
]

const ARTICLE_SECTION_BY_SLUG: Record<string, string> = {
  welcome: 'getting-started-first-steps',
  'quick-start': 'getting-started-first-steps',
  'navigation-and-records': 'getting-started-using-openbooks',
  glossary: 'getting-started-using-openbooks',
  'assistant-chat': 'getting-started-using-openbooks',
  'switching-from-small-business-systems': 'switching-small-business',
  'switching-from-enterprise-systems': 'switching-erp',
  'accounting-model': 'accounting-ledger',
  'transaction-lifecycle': 'accounting-ledger',
  'chart-of-accounts-and-dimensions': 'accounting-ledger',
  'parties-items-and-projects': 'accounting-master-data',
  'revenue-recognition': 'accounting-advanced',
  'fixed-assets-depreciation': 'accounting-advanced',
  'allocations': 'accounting-advanced',
  'sales-workflow': 'transactions-daily',
  'purchasing-workflow': 'transactions-daily',
  'payments-and-applications': 'transactions-daily',
  'property-management': 'transactions-daily',
  'financial-reports': 'reporting-guides',
  'analytics-and-saved-views': 'reporting-guides',
  'agent-workbench': 'reporting-guides',
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
  'setup-agents-group': 'administration-company-setup',
  'tax-jurisdictions-and-nexus': 'administration-taxes',
  'tax-configuration': 'administration-taxes',
  'tax-returns-and-boxes': 'administration-taxes',
  'roles-and-permissions': 'administration-organization',
  'data-imports': 'administration-data',
  'audit-log': 'administration-data',
  'issue-reporting': 'administration-organization',
  'file-cabinet': 'administration-data',
  'record-customization': 'administration-customize',
  'custom-records': 'administration-customize',
  'custom-fields': 'administration-customize',
  'pdf-templates': 'administration-customize',
  'navigation-customization': 'administration-customize',
  apps: 'apps-build',
  'app-builder': 'apps-build',
  'app-api-reference': 'apps-build',
  'app-assistant-tools': 'apps-build',
  'scripting-engine': 'apps-build',
  'scripting-api-reference': 'apps-build',
  flows: 'apps-automation',
  'query-console': 'apps-automation',
  'rest-api': 'apps-automation',
  'mcp-control': 'apps-automation',
  sandboxes: 'apps-automation',
}

const RAW_DOC_ARTICLES: DocArticle[] = [
  welcome,
  quickStart,
  navigationAndRecords,
  glossary,
  assistantChat,
  ...switchingArticles,
  accountingModel,
  transactionLifecycle,
  chartOfAccountsAndDimensions,
  partiesItemsAndProjects,
  revenueRecognition,
  fixedAssetsDepreciation,
  allocations,
  salesWorkflow,
  purchasingWorkflow,
  paymentsAndApplications,
  propertyManagement,
  bankingAndReconciliation,
  periodClose,
  projectTypes, overheadCosting, laborCosting, laborPricing, payroll, employmentMigration, positionsAndHeadcount, hrmProcesses, inboxAndHome, automations, correctingAndRescinding, performanceAndRetention, continuousPerformance, selfService, leaveTimeVersusValue, recruitingFunnel, benefitsEnrollment, fieldTickets, subcontractorCompliance, compensationAndTransparency,
  // HR-13 begin
  certifiedPayrollPrevailingWagePerDiem,
  // HR-13 end
  // HR-14 begin
  certificationsLicensesDispatch,
  // HR-14 end
  // HR-19 begin
  documentsSignaturesAndRetention,
  engagementSurveys,
  orgChartAndDirectory,
  // HR-19 end
  // HR-18 begin
  structuredInterviewsOffersJobBoards,
  // HR-18 end
  // HR-21 begin
  payslipExplanations,
  payrollChecks,
  aiGovernanceLedger,
  // HR-21 end
  // HR-14 begin: pre-existing red on the stacked base — the 31defe406
  // reconciliation left fieldTickets/subcontractorCompliance listed twice
  // (once on the long line above, once here). The duplicate line is removed.
  // HR-14 end
  // HR-14 deduped fieldTickets/subcontractorCompliance (listed on the long
  // line above) — HR-20 keeps that removal and adds only its own articles.
  // HR-20 begin
  fieldClockIn,
  crewTimeEntry,
  // HR-20 end
  itemRates,
  financialReports,
  analyticsAndSavedViews,
  agentWorkbench,
  migrateWithAConnector,
  migrationAndCutover,
  reconciliationBeforeCutover,
  quickBooksDesktopConnector,
  netSuiteBridge,
  apps,
  appBuilder,
  extensions,
  appApiReference,
  appAssistantTools,
  mcpControl,
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
  issueReporting,
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
