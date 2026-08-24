import { DOC_KIND_FEATURE } from './document-kinds'
import { MODULE_BY_KEY, type NavModule } from './nav/registry'

/**
 * Searchable/posting document kind → stable native module identity. Module
 * metadata, permission, feature consistency, and record addressing stay in
 * their established catalogs instead of being copied by each consumer.
 */
export const TRANSACTION_MODULE_BY_KIND = Object.freeze({
  vendor_bill: 'ap-bills',
  vendor_credit: 'ap-bills',
  purchase_order: 'purchase-orders',
  customer_invoice: 'ar-invoices',
  customer_credit: 'ar-invoices',
  quote: 'estimates',
  sales_order: 'sales-orders',
  card_charge: 'banking-transactions',
  card_refund: 'banking-transactions',
  check: 'banking-transactions',
  deposit: 'banking-transactions',
  transfer: 'banking-transactions',
  vendor_payment: 'payments',
  customer_payment: 'receipts',
  expense_report: 'expenses',
  field_ticket: 'field-tickets',
  journal: 'journal',
  project_charge: 'projects',
  pay_run: 'payroll',
} as const)

export type TransactionKind = keyof typeof TRANSACTION_MODULE_BY_KIND

export const TRANSACTION_KINDS = Object.freeze(
  Object.keys(TRANSACTION_MODULE_BY_KIND) as TransactionKind[],
)

export function transactionModule(docKind: string | null | undefined): NavModule | undefined {
  if (!docKind) return undefined
  const moduleKey = TRANSACTION_MODULE_BY_KIND[docKind as TransactionKind]
  return moduleKey ? MODULE_BY_KEY.get(moduleKey) : undefined
}

/** A module switch that hides navigation/search without disabling the generic
 * document domain APIs. True API gates remain exclusively in DOC_KIND_FEATURE. */
export function transactionNavigationOnlyFeature(
  docKind: string | null | undefined,
): string | undefined {
  if (!docKind) return undefined
  const navigationFeature = transactionModule(docKind)?.featureKey
  return navigationFeature !== DOC_KIND_FEATURE[docKind] ? navigationFeature : undefined
}

/**
 * Validate the joins between the shared kind, feature, and navigation catalogs.
 * Called at module load so a missing permission or native destination fails
 * closed before a consumer can expose a record.
 */
export function assertTransactionLinkRegistry(
  modules: ReadonlyMap<string, NavModule> = MODULE_BY_KEY,
): void {
  const issues: string[] = []
  for (const [docKind, moduleKey] of Object.entries(TRANSACTION_MODULE_BY_KIND)) {
    const module = modules.get(moduleKey)
    if (!module) {
      issues.push(`${docKind}: missing navigation module "${moduleKey}"`)
      continue
    }
    if (!module.requiredPermission) issues.push(`${docKind}: module "${moduleKey}" has no permission`)
    if (!module.recordTarget) issues.push(`${docKind}: module "${moduleKey}" has no record target`)
    const feature = DOC_KIND_FEATURE[docKind]
    if (feature && module.featureKey !== feature) {
      issues.push(
        `${docKind}: domain feature "${feature}" does not match module "${module.featureKey ?? 'none'}"`,
      )
    }
  }
  if (issues.length > 0) throw new Error(`invalid transaction link registry:\n${issues.join('\n')}`)
}

assertTransactionLinkRegistry()

export interface ModuleDrawerContext {
  projectId?: string | null
}

/**
 * The URL that opens a transaction's native module drawer, or null when the
 * entry has no source document (system-generated GL entries — depreciation,
 * closing, fx revaluation — which only have the read-only ledger flyout).
 */
export function moduleDrawerHref(
  docKind: string | null | undefined,
  docId: string | null | undefined,
  context: ModuleDrawerContext = {},
): string | null {
  if (!docKind || !docId) return null
  const module = transactionModule(docKind)
  const target = module?.recordTarget
  if (!module || !target) return null
  const encodedId = encodeURIComponent(docId)
  if (target.kind === 'query') return `${module.href}?${target.param}=${encodedId}`
  if (target.kind === 'nested') return `${module.href}/${target.segment}/${encodedId}`
  if (!context.projectId) return `${module.href}?projectTab=transactions`
  const params = new URLSearchParams({
    project: context.projectId,
    projectTab: 'transactions',
    projectTxn: docId,
    projectTxnKind: docKind,
  })
  return `${module.href}?${params}`
}

/**
 * Builds the app-wide, in-context drawer URL for a posted GL entry. Source
 * documents open their native drawer; GL-only entries open the ledger drawer.
 */
export function transactionDrawerHref({
  pathname,
  query,
  entryId,
  docKind,
  docId,
}: {
  pathname: string
  query: string
  entryId: string
  docKind?: string | null
  docId?: string | null
}) {
  const params = new URLSearchParams(query)
  params.delete('reportRecord')
  params.delete('reportRecordKind')
  params.delete('txn')
  params.delete('drawerReturn')
  params.delete('form')
  params.delete('transactionTab')
  const baseQuery = params.toString()
  const returnHref = baseQuery ? `${pathname}?${baseQuery}` : pathname
  if (docKind && docId) {
    params.set('reportRecord', docId)
    params.set('reportRecordKind', docKind)
    params.set('drawerReturn', returnHref)
  } else {
    params.set('txn', entryId)
  }
  return `${pathname}?${params}`
}
