import type { schema } from "../platform/db.ts";
/** Posting input contracts and the shared refusal identity; no runtime database dependency. */

export type PostingDocument = typeof schema.documents.$inferSelect;
export type PostingDocumentLine = typeof schema.documentLines.$inferSelect;
export type Doc = PostingDocument;
export type DocLine = PostingDocumentLine;

export interface KernelLine {
  accountId: string;
  /** Signed transaction-currency amount; translated before ledger insertion. */
  amount: string;
  currency?: string;
  txnAmount?: string;
  fxRate?: string;
  /** Legal entity; defaults to the document's subsidiary (journals may span). */
  subsidiaryId?: string | null;
  partyId?: string | null;
  departmentId?: string | null;
  projectId?: string | null;
  locationId?: string | null;
  classId?: string | null;
  equipmentUnitId?: string | null;
  /** Custom segment assignments keyed by segment_definitions.key. */
  extraDims?: Record<string, string>;
  paymentCardId?: string | null;
  taxCodeId?: string | null;
  memo?: string | null;
  dueDate?: string | null;
  isOpenItem?: boolean;
}

export interface PostingDeps {
  /** Historical replay: bypass source-imported period locks, never user locks. */
  migration?: boolean;
  /** org-level control accounts (from orgs.settings.controlAccounts). */
  control: {
    ar: string;
    ap: string;
    bank: string;
    taxCollected?: string;
    taxPaid?: string;
    employeePayable?: string;
    /** Debit control for personal-on-corporate-card lines (0171). Resolved
     * lazily like the tax fallbacks: required only when a personal line
     * actually posts, so orgs that never file one need not configure it. */
    employeeReceivable?: string;
    fxRealizedGainLoss?: string;
  };
  /** Resolved by postDocument when the document has a payment card. */
  cardLiabilityAccountId?: string;
  /**
   * Accounts whose journal lines are OPEN ITEMS (all asset_receivable /
   * liability_payable accounts, plus the designated employeePayable and
   * employeeReceivable controls). Resolved lazily by postDocument /
   * regenerateGlImpactTx for journal, deposit, expense report and check
   * documents; lets their AR/AP legs participate in payment applications —
   * openbooks' model applies ANY crediting document (journal, credit memo,
   * payment) to open items, the way source platform's own receipt journals
   * settle invoices.
   */
  openItemAccountIds?: Set<string>;
  /**
   * Per-tax-code control accounts (tax_codes.collected/paid_account_id).
   * Resolved lazily by postDocument / regenerateGlImpactTx; codes without an
   * account fall back to the org control (taxCollected / taxPaid).
   */
  taxCollectedByCode?: Map<string, string>;
  taxPaidByCode?: Map<string, string>;
  /** Exact per-line tax calculation snapshots, expanded from a code or group. */
  taxComponentsByLine?: Map<string, TaxPostingComponent[]>;
  /**
   * document_line id → deferred-revenue account, for customer_invoice lines
   * whose item carries a recognition rule (ASC 606). Such lines credit deferred
   * revenue instead of income; engine/src/revenue/recognition.ts later drains
   * deferred → earned over the term. Resolved lazily by postDocument /
   * regenerateGlImpactTx for customer_invoice documents.
   */
  deferralAccountByLine?: Map<string, string>;
  /**
   * document_line id → the account a vendor_bill inventory line should DEBIT
   * (received-not-billed clearing, else the inventory asset account). The
   * inventory subledger then receives the stock. Resolved lazily by
   * postDocument / regenerateGlImpactTx for vendor_bill documents.
   */
  inventoryAssetByLine?: Map<string, string>;
  /**
   * document_line id → inventory variance/adjustment account for a native
   * vendor return. The credit books the commercial amount here; the inventory
   * return journal debits carried cost here, leaving only policy variance.
   */
  inventoryReturnOffsetByLine?: Map<string, string>;
}

export interface TaxPostingComponent {
  taxCodeId: string;
  sequence: number;
  taxAmount: string;
  recoverableAmount: string;
  nonrecoverableAmount: string;
  calculationType: "standard" | "withholding" | "reverse_charge";
  collectedAccountId: string | null;
  paidAccountId: string | null;
  withholdingAccountId: string | null;
  /** Full calculation fields retained for provider requotes before posting. */
  ratePercent?: string;
  taxableAmount?: string;
  priceIncludesTax?: boolean;
  compoundOnPrevious?: boolean;
  roundingScale?: number;
  recoverablePercent?: string;
}

export type ExpenseSettlement = "out_of_pocket" | "company_paid" | "personal";

export class PostingError extends Error {}

/** Automation and audit controls applied across the posting phases. */
export type PostDocumentOptions = {
    deferEffects?: boolean;
    /** Source-authoritative replay runs the accounting kernel and product
     * subledgers without re-firing tenant-authored UI scripts or flows. */
    suppressAutomation?: boolean;
    audit?: { actorId: string | null; source: string };
  };

/** Raised when a GL-affecting edit would land in a closed accounting period. */
export class ClosedPeriodError extends Error {}
