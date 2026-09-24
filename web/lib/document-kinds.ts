/**
 * Client-safe document-kind configuration — shared by the server machinery
 * (web/lib/documents.ts) and the client DocumentDrawer. Kept free of any
 * server-only imports (no db, no 'server-only') so it can be bundled for the
 * browser. Mirrors the web/lib/order-kinds.ts split.
 */

export type DocFamily = 'ap' | 'ar' | 'bank' | 'transfer' | 'gl'
export type PermNamespace = 'ap' | 'ar' | 'gl'

/**
 * Period-close module whose lock governs posting this kind — mirrors
 * engine/src/close/close.ts CLOSE_MODULES. Required on every registry entry so a
 * new document kind cannot exist without an explicit close-module decision:
 * engine/src/close/close.test.ts asserts closeModuleForDocument(kind) equals this
 * field for every kind, so an unmapped kind fails typecheck here and CI there
 * instead of silently posting under the GL lock alone.
 */
export type DocCloseModule = 'ar' | 'ap' | 'banking' | 'assets' | 'tax' | 'gl'

export interface DocKindConfig {
  kind: string
  family: DocFamily
  numberPrefix: string
  /** Permission namespace driving create/read/post gates. */
  permNamespace: PermNamespace
  /** Period-close module whose lock blocks posting this kind. */
  closeModule: DocCloseModule
  /** next-intl namespace holding this kind's drawer + list copy. */
  i18n: 'ap' | 'ar' | 'banking'
  /** Party role for the header picker; null = no party field. */
  partyRole: 'vendor' | 'customer' | null
  /**
   * Optional party role for the header picker (fallback form path). Unlike
   * partyRole it never mandates a party: the submit gate and the server edit
   * guard key off partyRole only, so anonymous documents stay valid.
   */
  optionalPartyRole?: 'vendor' | 'customer' | null
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
    kind: 'vendor_bill', closeModule: 'ap', family: 'ap', numberPrefix: 'BILL-', permNamespace: 'ap', i18n: 'ap',
    partyRole: 'vendor', accountTypes: null, hasTax: true, hasDueDate: true, hasReference: true,
    fundingSource: null, isOpenItem: true, showsBalance: false, directPost: false,
  },
  vendor_credit: {
    kind: 'vendor_credit', closeModule: 'ap', family: 'ap', numberPrefix: 'VCRED-', permNamespace: 'ap', i18n: 'ap',
    partyRole: 'vendor', accountTypes: null, hasTax: true, hasDueDate: true, hasReference: true,
    fundingSource: null, isOpenItem: true, showsBalance: false, directPost: false,
  },
  customer_invoice: {
    kind: 'customer_invoice', closeModule: 'ar', family: 'ar', numberPrefix: 'INV-', permNamespace: 'ar', i18n: 'ar',
    partyRole: 'customer', accountTypes: ['income', 'income_other'], hasTax: true, hasDueDate: true,
    hasReference: true, fundingSource: null, isOpenItem: true, showsBalance: true, directPost: false,
  },
  customer_credit: {
    kind: 'customer_credit', closeModule: 'ar', family: 'ar', numberPrefix: 'CM-', permNamespace: 'ar', i18n: 'ar',
    partyRole: 'customer', accountTypes: ['income', 'income_other'], hasTax: true, hasDueDate: true,
    hasReference: true, fundingSource: null, isOpenItem: true, showsBalance: false, directPost: false,
  },
  card_charge: {
    kind: 'card_charge', closeModule: 'ap', family: 'bank', numberPrefix: 'CC-', permNamespace: 'ap', i18n: 'banking',
    partyRole: null, accountTypes: null, hasTax: true, hasDueDate: false, hasReference: false,
    fundingSource: 'card', isOpenItem: false, showsBalance: false, directPost: true,
  },
  card_refund: {
    kind: 'card_refund', closeModule: 'ap', family: 'bank', numberPrefix: 'CRF-', permNamespace: 'ap', i18n: 'banking',
    partyRole: null, accountTypes: null, hasTax: true, hasDueDate: false, hasReference: false,
    fundingSource: 'card', isOpenItem: false, showsBalance: false, directPost: true,
  },
  // Check: optional vendor payee (partyRole stays null so anonymous expense
  // checks stay valid — the engine settles AP open items via doc.partyId when
  // present) and a 'bank' funding source. The drawer renders the payee picker
  // from optionalPartyRole and the funding bank from fundingSource.
  check: {
    kind: 'check', closeModule: 'ap', family: 'bank', numberPrefix: 'CHK-', permNamespace: 'ap', i18n: 'banking',
    partyRole: null, optionalPartyRole: 'vendor', accountTypes: null, hasTax: true, hasDueDate: false, hasReference: true,
    fundingSource: 'bank', isOpenItem: false, showsBalance: false, directPost: true,
  },
  // Deposit (source platform "Make Deposits"): money IN to a chosen bank account,
  // crediting one or more source accounts (income, undeposited funds, clearing).
  // The destination bank is stored on doc.custom.controlAccountId and read by
  // the posting rule's controlOverride; falls back to the org default bank.
  // Checks share the same fundingSource/bag contract for the funding bank.
  deposit: {
    kind: 'deposit', closeModule: 'banking', family: 'bank', numberPrefix: 'DEP-', permNamespace: 'gl', i18n: 'banking',
    partyRole: null, accountTypes: null, hasTax: false, hasDueDate: false, hasReference: true,
    fundingSource: 'bank', isOpenItem: false, showsBalance: false, directPost: true,
  },
  transfer: {
    kind: 'transfer', closeModule: 'banking', family: 'transfer', numberPrefix: 'TRF-', permNamespace: 'gl', i18n: 'banking',
    partyRole: null, accountTypes: null, hasTax: false, hasDueDate: false, hasReference: false,
    fundingSource: null, isOpenItem: false, showsBalance: false, directPost: true,
  },
  // Project charge / resource usage — allocates a pooled, already-incurred cost
  // (non-inventory materials, owned equipment, internal services) onto a project
  // at a cost rate, carrying a billable rate for T&M. Posts DR project COGS /
  // CR cost pool (see the project_charge rule in engine/src/ledger/posting.ts). Internal
  // (no party); direct-post.
  project_charge: {
    kind: 'project_charge', closeModule: 'gl', family: 'gl', numberPrefix: 'CHG-', permNamespace: 'gl', i18n: 'banking',
    partyRole: null, accountTypes: null, hasTax: false, hasDueDate: false, hasReference: true,
    fundingSource: null, isOpenItem: false, showsBalance: false, directPost: true,
  },
  // Pay run: committed payroll GL projection (signed lines, like a journal).
  // Lines are machine-built by engine/src/payroll/run.ts commitPayRun — the
  // drawer never edits them; the payroll workspace is the editing surface.
  pay_run: {
    kind: 'pay_run', closeModule: 'gl', family: 'gl', numberPrefix: 'PAY-', permNamespace: 'gl', i18n: 'banking',
    partyRole: null, accountTypes: null, hasTax: false, hasDueDate: false, hasReference: false,
    fundingSource: null, isOpenItem: false, showsBalance: false, directPost: true,
  },
}

export const AP_KINDS = ['vendor_bill', 'vendor_credit'] as const
export const AR_KINDS = ['customer_invoice', 'customer_credit'] as const
export const BANK_KINDS = ['card_charge', 'card_refund', 'check', 'deposit', 'transfer'] as const

/**
 * Kinds creatable through the uniform unsaved-create slice: every shared
 * DOCUMENT transaction kind whose New button opens the tenant-customizable
 * DocumentDrawer in createMode over an in-memory payload. Orders, journals,
 * payments, expenses, project charges, and pay runs keep their own writers
 * and are refused by POST /api/documents.
 */
export const DOCUMENT_CREATE_KINDS = [
  'customer_invoice',
  'customer_credit',
  'vendor_bill',
  'vendor_credit',
  'card_charge',
  'card_refund',
  'check',
  'deposit',
  'transfer',
] as const

export type DocumentCreateKind = (typeof DOCUMENT_CREATE_KINDS)[number]

export function isDocumentCreateKind(kind: string): kind is DocumentCreateKind {
  return (DOCUMENT_CREATE_KINDS as readonly string[]).includes(kind)
}

/**
 * URL-only create target: opening New allocates nothing — no document, no
 * number, no lines, no audit row. The list loader renders the shared
 * DocumentDrawer in createMode over this URL, and the first write happens
 * on explicit Save (POST /api/documents). Cancel/close navigates away and
 * writes nothing.
 */
export function documentCreateHref(basePath: string, kind: string): string {
  if (!isDocumentCreateKind(kind)) throw new Error(`kind "${kind}" is not creatable here`)
  return `${basePath}?doc=new&kind=${kind}&mode=edit`
}

/** Optional-module kinds: the generic document APIs must 404 when the feature is off. */
export const DOC_KIND_FEATURE: Partial<Record<string, string>> = {
  quote: 'orders',
  sales_order: 'orders',
  purchase_order: 'orders',
  expense_report: 'expenses',
  field_ticket: 'fieldTickets',
  pay_run: 'payroll',
  project_charge: 'projects',
}

export function docKindConfig(kind: string): DocKindConfig | undefined {
  return DOC_KINDS[kind]
}

/**
 * Permission key for reading a document of a kind through the generic
 * document endpoints. Project charges are a Projects-domain record (their
 * drawer, list and kind-specific routes gate on projects.read), so they
 * read through the Projects grant rather than the GL namespace their
 * posting rule lives under.
 */
export function documentReadPermission(kind: string): string {
  if (kind === 'project_charge') return 'projects.read'
  return readPermission(kind)
}

/**
 * Permission key for editing a document of a kind through the generic
 * document endpoints. Mirrors documentReadPermission: project charges edit
 * through projects.manage.
 */
export function documentEditPermission(kind: string): string {
  if (kind === 'project_charge') return 'projects.manage'
  return createPermission(kind)
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
