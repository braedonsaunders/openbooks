/**
 * Client-safe document-kind configuration — shared by the server machinery
 * (web/lib/documents.ts) and the client DocumentDrawer. Kept free of any
 * server-only imports (no db, no 'server-only') so it can be bundled for the
 * browser. Mirrors the web/lib/order-kinds.ts split.
 */

export type DocFamily = 'ap' | 'ar' | 'bank' | 'transfer' | 'gl'
export type PermNamespace = 'ap' | 'ar' | 'gl'

export interface DocKindConfig {
  kind: string
  family: DocFamily
  numberPrefix: string
  /** Permission namespace driving create/read/post gates. */
  permNamespace: PermNamespace
  /** next-intl namespace holding this kind's drawer + list copy. */
  i18n: 'ap' | 'ar' | 'banking'
  /** Party role for the header picker; null = no party field. */
  partyRole: 'vendor' | 'customer' | null
  /**
   * Account-type filter for the line account picker; null = any active
   * non-summary account (preserves the original bill behaviour).
   */
  accountTypes: readonly string[] | null
  hasTax: boolean
  hasDueDate: boolean
  /** Show a reference-number field (vendor invoice #, cheque #, …). */
  hasReference: boolean
  /** Funding-source picker for banking docs; null = none. */
  fundingSource: 'card' | 'bank' | null
  /** Posts to an AP/AR control open item (carries a balance to apply). */
  isOpenItem: boolean
  /**
   * Show a balance/bucket in the drawer + list. Invoices carry an amount due
   * the customer owes; credit memos' "applied" flows the opposite direction
   * (from-line, not to-line), so a naive balance would mislead — credits show
   * their posted status only until application views gain a credit-aware pass.
   */
  showsBalance: boolean
  /** Direct-post: draft → Post with no approval step. */
  directPost: boolean
}

export const DOC_KINDS: Record<string, DocKindConfig> = {
  vendor_bill: {
    kind: 'vendor_bill', family: 'ap', numberPrefix: 'BILL-', permNamespace: 'ap', i18n: 'ap',
    partyRole: 'vendor', accountTypes: null, hasTax: true, hasDueDate: true, hasReference: true,
    fundingSource: null, isOpenItem: true, showsBalance: false, directPost: false,
  },
  vendor_credit: {
    kind: 'vendor_credit', family: 'ap', numberPrefix: 'VCRED-', permNamespace: 'ap', i18n: 'ap',
    partyRole: 'vendor', accountTypes: null, hasTax: true, hasDueDate: true, hasReference: true,
    fundingSource: null, isOpenItem: true, showsBalance: false, directPost: false,
  },
  customer_invoice: {
    kind: 'customer_invoice', family: 'ar', numberPrefix: 'INV-', permNamespace: 'ar', i18n: 'ar',
    partyRole: 'customer', accountTypes: ['income', 'income_other'], hasTax: true, hasDueDate: true,
    hasReference: true, fundingSource: null, isOpenItem: true, showsBalance: true, directPost: false,
  },
  customer_credit: {
    kind: 'customer_credit', family: 'ar', numberPrefix: 'CM-', permNamespace: 'ar', i18n: 'ar',
    partyRole: 'customer', accountTypes: ['income', 'income_other'], hasTax: true, hasDueDate: true,
    hasReference: true, fundingSource: null, isOpenItem: true, showsBalance: false, directPost: false,
  },
  card_charge: {
    kind: 'card_charge', family: 'bank', numberPrefix: 'CC-', permNamespace: 'ap', i18n: 'banking',
    partyRole: null, accountTypes: null, hasTax: true, hasDueDate: false, hasReference: false,
    fundingSource: 'card', isOpenItem: false, showsBalance: false, directPost: true,
  },
  card_refund: {
    kind: 'card_refund', family: 'bank', numberPrefix: 'CRF-', permNamespace: 'ap', i18n: 'banking',
    partyRole: null, accountTypes: null, hasTax: true, hasDueDate: false, hasReference: false,
    fundingSource: 'card', isOpenItem: false, showsBalance: false, directPost: true,
  },
  check: {
    kind: 'check', family: 'bank', numberPrefix: 'CHK-', permNamespace: 'ap', i18n: 'banking',
    partyRole: null, accountTypes: null, hasTax: true, hasDueDate: false, hasReference: true,
    fundingSource: 'bank', isOpenItem: false, showsBalance: false, directPost: true,
  },
  // Deposit (NetSuite "Make Deposits"): money IN to a chosen bank account,
  // crediting one or more source accounts (income, undeposited funds, clearing).
  // The destination bank is stored on doc.custom.controlAccountId and read by
  // the posting rule's controlOverride; falls back to the org default bank.
  deposit: {
    kind: 'deposit', family: 'bank', numberPrefix: 'DEP-', permNamespace: 'gl', i18n: 'banking',
    partyRole: null, accountTypes: null, hasTax: false, hasDueDate: false, hasReference: true,
    fundingSource: 'bank', isOpenItem: false, showsBalance: false, directPost: true,
  },
  transfer: {
    kind: 'transfer', family: 'transfer', numberPrefix: 'TRF-', permNamespace: 'gl', i18n: 'banking',
    partyRole: null, accountTypes: null, hasTax: false, hasDueDate: false, hasReference: false,
    fundingSource: null, isOpenItem: false, showsBalance: false, directPost: true,
  },
  // Project charge / resource usage — allocates a pooled, already-incurred cost
  // (non-inventory materials, owned equipment, internal services) onto a project
  // at a cost rate, carrying a billable rate for T&M. Posts DR project COGS /
  // CR cost pool (see the project_charge rule in engine/src/posting.ts). Internal
  // (no party); direct-post.
  project_charge: {
    kind: 'project_charge', family: 'gl', numberPrefix: 'CHG-', permNamespace: 'gl', i18n: 'banking',
    partyRole: null, accountTypes: null, hasTax: false, hasDueDate: false, hasReference: true,
    fundingSource: null, isOpenItem: false, showsBalance: false, directPost: true,
  },
}

export const AP_KINDS = ['vendor_bill', 'vendor_credit'] as const
export const AR_KINDS = ['customer_invoice', 'customer_credit'] as const
export const BANK_KINDS = ['card_charge', 'card_refund', 'check', 'deposit', 'transfer'] as const

export function docKindConfig(kind: string): DocKindConfig | undefined {
  return DOC_KINDS[kind]
}

/** Permission key for the create/submit action on a kind. */
export function createPermission(kind: string): string {
  const cfg = DOC_KINDS[kind]
  if (!cfg) throw new Error(`unknown document kind "${kind}"`)
  return cfg.permNamespace === 'gl' ? 'gl.post' : `${cfg.permNamespace}.create`
}

/** Permission key for the post action on a kind. */
export function postPermission(kind: string): string {
  const cfg = DOC_KINDS[kind]
  if (!cfg) throw new Error(`unknown document kind "${kind}"`)
  return cfg.permNamespace === 'gl' ? 'gl.post' : `${cfg.permNamespace}.post`
}

/** Permission key for reading a kind (ap.read / ar.read / gl.read). */
export function readPermission(kind: string): string {
  const cfg = DOC_KINDS[kind]
  if (!cfg) throw new Error(`unknown document kind "${kind}"`)
  return `${cfg.permNamespace}.read`
}
