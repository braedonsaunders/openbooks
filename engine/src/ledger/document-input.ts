/** Transport-neutral edit contracts; monetary values remain exact decimal strings. */
import type { TaxQuoteRequest, TaxQuoteResult } from '../tax/rate-providers.ts'

export interface BillLineInput {
  accountId: string
  description?: string | null
  amount: string
  taxCodeId?: string | null
  taxGroupId?: string | null
  /** Manual tax override: when true, `taxAmount` is honored instead of computed. */
  taxOverridden?: boolean
  taxAmount?: string | null
  custom?: Record<string, unknown>
  /** Internal pre-persistence provider evidence; never accepted from API input. */
  providerQuote?: {
    providerConfigId: string
    request: TaxQuoteRequest
    result: TaxQuoteResult
  }
}

/** A line as accepted on a document edit (built-ins + dimensions + custom). */
export interface DocumentLineInput extends BillLineInput {
  /**
   * Stable identity of a persisted line being edited (absent/null = new
   * line). Never trusted for provenance: the server re-attaches native
   * evidence from its own locked rows and strips caller-supplied native keys.
   */
  lineId?: string | null
  itemId?: string | null
  quantity?: string | null
  unit?: string | null
  unitPrice?: string | null
  /** Line entity: the customer/vendor/employee this line belongs to. */
  partyId?: string | null
  departmentId?: string | null
  projectId?: string | null
  locationId?: string | null
  classId?: string | null
  /** Warehouse used by inventory receipt or issue effects for this line. */
  stockLocationId?: string | null
  /**
   * Operator-chosen stock return on a credit memo: the posted receipt (vendor
   * credit) or shipment (customer credit) whose units are coming back.
   *
   * Unlike the other native evidence this one IS a caller choice, so it is
   * accepted here as a typed field rather than through `custom` — the server
   * validates it against the offerable sources and writes the trusted
   * `custom.inventoryReturn` bag itself, which the return engines read. A
   * caller can therefore name a source but never forge the evidence.
   *
   * Tri-state, like `distributionLocked`: absent preserves the stored
   * selection, null clears it, an object replaces it.
   */
  inventoryReturnSource?: {
    movementId: string
    lotId?: string | null
    serialId?: string | null
  } | null
  extraDims?: Record<string, string | null>
  custom?: Record<string, unknown>
  /** Entry-mode allocation: rule key to explode this line (explicit request). */
  distributionKey?: string | null
  /** Stored distribution group this submitted line belongs to (re-save matching). */
  distributionGroupId?: string | null
  /** True locks the group against re-explosion; false unlocks; absent preserves. */
  distributionLocked?: boolean | null
}

/** The header + lines payload for a document edit. Every field is optional; an
 *  absent key leaves the stored value untouched (partial patch). */
export interface DocumentEditInput {
  /** Required evidence for every posted-document amendment. Not persisted on
   * the document; stored only in the immutable before/after audit envelope. */
  amendmentReason?: string
  /** Optimistic concurrency token from documents.revision_seq. Required when
   * editing any existing document. A newly minted, still-private draft is the
   * sole initialization path that may omit it. */
  expectedUpdatedAt?: string
  partyId?: string | null
  paymentCardId?: string | null
  documentDate?: string
  dueDate?: string | null
  referenceNumber?: string | null
  memo?: string | null
  postingDate?: string | null
  departmentId?: string | null
  projectId?: string | null
  locationId?: string | null
  classId?: string | null
  extraDims?: Record<string, string | null>
  subsidiaryId?: string | null
  expectedPayDate?: string | null
  paymentHoldReason?: string | null
  internalNotes?: string | null
  billingMethod?: string | null
  isFinalInvoice?: boolean
  currency?: string
  custom?: Record<string, unknown>
  lines?: DocumentLineInput[]
  /** Stored distribution groups collapsing back to one line each. */
  unsplitDistributionGroups?: string[]
}

/** The pre-edit snapshot a caller loads under its own org scope. */
export type DocumentEditCurrent = {
  kind: string
  status: string
  total: string
  taxTotal: string
  partyId: string | null
  documentDate: string
  updatedAt: string
  custom?: Record<string, unknown>
  /** Owning legal entity; present on rows loaded after the provider-tax fix. */
  subsidiaryId?: string | null
};
