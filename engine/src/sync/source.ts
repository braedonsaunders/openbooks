import type { NativeContext, NativeDocument } from "./native.ts";

/**
 * MigrationSource — the adapter contract for pulling accounting data out of an
 * external system, NATIVELY. An adapter emits real business documents
 * (invoices, bills, payments, journals, orders) resolved against openbooks
 * ids; the sync engine inserts them and posts them through the REAL posting
 * engine (postDocument → RULES → kernel), so the GL is a byproduct of native
 * transactions — never a replayed photocopy. Payment applications ride along,
 * so AR/AP open balances are correct, tied bill-to-payment.
 *
 * Implement this once and the one-click migration, the incremental "mirror",
 * trial-balance + open-item verification, the worker, and the UI come for
 * free. NetSuite is the reference adapter.
 */

// --- Entity (master-data) streams --------------------------------------------

/** One canonical master-data record (see migrate.ts for the loader). */
export interface SourceEntity {
  /** Immutable id in this adapter's source namespace. It is never compared to
   * another adapter's id, even when both happen to use the same characters. */
  sourceRef: string;
  /** Natural key for the target resource (account number, party short code…). */
  naturalKey?: string | null;
  /** Parent's `sourceRef`, for hierarchical resources (accounts, dimensions). */
  parentRef?: string | null;
  fields: Record<string, unknown>;
}

/**
 * A stream of one entity kind. `resource` is the data-io resource key
 * (`"accounts"`, `"parties"`, `"departments"`, `"items"`, `"projects"`, …);
 * streams load in array order, so dependencies come first.
 */
export interface EntityStream {
  resource: string;
  records: SourceEntity[];
}

// --- Native transaction stream ------------------------------------------------

/**
 * A source settlement link: payment/credit → the open item it settled.
 *
 * `amount` is stated in `currency` — NEVER assumed functional. The
 * reconciler resolves every link to functional carrying value itself (base
 * amounts pass through; amounts in a payment line's currency convert at the
 * line's booked rate; anything else needs `rate`) and REFUSES links whose
 * currency it cannot resolve, with a named error. A refused link fails the
 * run honestly; it is never silently under-applied.
 *
 * Per-adapter denomination (each cited from the vendor's public contract):
 * - NetSuite `nexttransactionlinelink.foreignamount` is transaction currency;
 *   the adapter also states the paying transaction's `exchangerate` and its
 *   `BUILTIN.DF(currency)` display value, resolved through the same
 *   `netSuiteCurrencyIso` rule the document builder uses (unstated = source
 *   base; unresolvable stays empty and refuses).
 * - QBO links carry the payment's `CurrencyRef` amount at its `ExchangeRate`
 *   (Intuit: linked transactions share one currency; ExchangeRate converts
 *   that payment's currency to home).
 * - Xero payment/allocation `Amount` must not exceed the invoice outstanding,
 *   i.e. it is denominated in the invoice's `CurrencyCode`, at the
 *   payment's/credit's own `CurrencyRate` (Xero Accounting API:
 *   `Payment.CurrencyRate` is the "Exchange rate when payment is received.
 *   Only used for non base currency invoices and credit notes"). Every leg is
 *   an UNSIGNED magnitude on both sides: the shared `Allocation` schema
 *   (`Amount`: "the amount being applied to the invoice") serves CreditNote,
 *   Prepayment AND Overpayment allocations, and `Payment.Amount` is "The
 *   amount of the payment" with a PaymentType enum covering ACCRECPAYMENT and
 *   ACCPAYPAYMENT — so the adapter normalizes with abs() and skips only
 *   zero/missing legs.
 * - Odoo `account.partial.reconcile.amount` is company currency (Odoo:
 *   reconciliation matches "the invoice price in the invoice currency and
 *   the ... amount in your company currency").
 * - ERPNext Payment Entry `allocated_amount` is denominated in the invoice's
 *   account currency (ERPNext docs: "Allocate the invoice in its account
 *   currency"). The per-reference `exchange_rate` direction is unproven, so
 *   no producer rate is stated — foreign links price from the books or refuse.
 * - Dynamics states the invoice's `currencyCode` (Microsoft Learn, Business
 *   Central v2.0 `salesInvoice` resource, §Properties: `remainingAmount` "The
 *   amount including VAT" among the document totals, `currencyCode` "The
 *   default currency code for the sales invoice"; no LCY-denominated property
 *   exists, so blank means LCY = the company base). The v2.0
 *   `purchaseInvoice` resource exposes NO `remainingAmount`, so purchase
 *   settlement is never invented — it rides evidenced vendor-payment journal
 *   legs, and purchase open-item truth is status-driven (Paid → 0, otherwise
 *   total − journal-applied). The v2.0 `customerPayment` / `vendorPayment`
 *   resources expose NO currency property, so standalone journal amounts state
 *   the company base. The v2.0 `applyVendorEntry` resource carries
 *   `remainingAmount` but NO applied-amount, currency or rate property — no
 *   settlement-rate field exists on applied-entry detail — and no v2.0
 *   invoice, payment-journal or applied-entry resource exposes an FX-rate
 *   property, so Dynamics links never state a producer rate: they resolve
 *   through the books' own line rates and refuse loudly on any mismatch.
 */
export interface SourceApplicationLink {
  paymentRef: string;
  appliedRef: string;
  /** Positive decimal string, stated in `currency`. */
  amount: string;
  /** ISO 4217 code the amount is stated in, as reported by the source. */
  currency: string;
  /**
   * Functional currency per unit of `currency`, when the producer knows the
   * rate the source applied. Fallback only: the books' own line rate prices
   * any currency it already carries. Never defaulted — an absent rate plus
   * an unresolvable currency refuses the link.
   */
  rate?: string | null;
}

export interface NativeChanges {
  /** Insert-ready native documents (headers + lines, ids resolved). */
  documents: NativeDocument[];
  /** The FULL current application graph (the reconciler is delta-safe). */
  applications: SourceApplicationLink[];
  /** Source refs the source system reports deleted (voided in openbooks). */
  deletedRefs: string[];
  /** Source-clock high-water mark to persist for the next incremental pull. */
  syncedThrough: Date;
  /** Diagnostics: transactions the adapter could not build (ref → reason). */
  unbuildable: { ref: string; reason: string }[];
  /** Source transactions proven to have no business-ledger projection. Kept
   * in the full-sweep universe so they are not mistaken for deletions. */
  nonLedgerRefs?: string[];
}

// --- Verification ---------------------------------------------------------------

export interface SourceTrialBalanceRow {
  accountRef: string;
  balance: string; // signed decimal string, debit-positive
}

/** Source-ledger activity for one account in one calendar posting month. */
export interface SourceAccountMonthRow {
  accountRef: string;
  month: string; // YYYY-MM
  /** Exact source posting-period identity when the source exposes one. When
   * present on the complete source population, verification keys by this
   * value rather than collapsing adjustment/late-posted activity by month. */
  periodRef?: string | null;
  amount: string; // signed decimal string, debit-positive, in home currency
}

/**
 * Source-ledger activity for one project, account, and calendar posting month.
 *
 * This is deliberately a ledger projection rather than a commercial-document
 * projection: connectors must read the source system's authoritative posted
 * accounting lines, not infer GL impact from invoice/item lines.
 */
export interface SourceProjectAccountMonthRow {
  projectRef: string;
  accountRef: string;
  month: string; // YYYY-MM
  periodRef?: string | null;
  amount: string; // signed decimal string, debit-positive, in home currency
}

/** Source ground truth for one open item (invoice/bill): remaining unpaid. */
export type SourceOpenItem = {
  ref: string;
  unpaid: string;
};

export interface SourceLedgerContext {
  /** Source-native identifier of the authoritative ledger/book. */
  bookRef: string;
  /** Human-readable source-system terminology, e.g. "accounting book". */
  bookKind: string;
}

/**
 * Source-native billing disposition for a time entry. `billed` means the work
 * has been commercially consumed by billing; it does not assert that the
 * source exposes a one-to-one invoice line (fixed-price/progress billing often
 * does not).
 */
export interface SourceTimeEntryBillingState {
  sourceRef: string;
  billingStatus: "unbilled" | "billed";
  costingBasis: "actual" | "estimated";
  sourceStatus?: string | null;
  /** Financially material source facts. When exposed, the complete-population
   * rematerializer reconciles them as well as lifecycle state. */
  employeeRef?: string | null;
  projectRef?: string | null;
  itemRef?: string | null;
  departmentRef?: string | null;
  timeTypeRef?: string | null;
  workedOn?: string | null;
  hours?: string | null;
  costRate?: string | null;
  billRate?: string | null;
  isBillable?: boolean | null;
}

export interface SourceProjectCommercialState {
  sourceRef: string;
  /** Connector-normalized project-type key when the source exposes one. */
  billingMethod:
    | "time_and_materials"
    | "fixed_price"
    | "cost_plus"
    | "not_to_exceed"
    | null;
  /** Source contract/ceiling amount; null means the source has no such fact. */
  contractValue: string | null;
}

/** Complete source population needed to rematerialize project financial state
 * without touching accounting documents, files, or rendered evidence. */
export interface SourceProjectFinancialInputs {
  timeEntryBillingStates: SourceTimeEntryBillingState[];
  projects: SourceProjectCommercialState[];
}

// --- The adapter -----------------------------------------------------------------

export interface MigrationSource {
  /** Stable machine identifier for the source namespace. Together with a
   * record's sourceRef this establishes the canonical `custom.source` origin
   * when the row is first landed. Explicitly mapped secondary adapter refs may
   * accumulate without replacing that origin. */
  readonly name: string;
  /**
   * Unique key under which this adapter's source ids live in each row's
   * `custom` JSON. Party and project identity is resolved only through this
   * key; loaders must never adopt those entities by matching another adapter's
   * id, display name, or natural key. Some canonical setup resources (for
   * example payment terms by name or tax codes by code) intentionally merge
   * through their own organization-scoped unique business key.
   *
   * A tenant that knows two source records represent the same real-world
   * entity may install an explicit, reviewed one-to-one mapping by placing this
   * adapter's refKey/sourceRef on the selected target row before sync. That
   * mapping is tenant configuration: validate both sides, reject ambiguity and
   * collisions, retain evidence, and audit the write. It is not connector
   * fallback behavior.
   */
  readonly refKey: string;
  /** ISO 4217 base currency of the source book. */
  readonly baseCurrency: string;

  /**
   * Source fiscal periods normalized into posting-period rows plus per-module
   * lock state. This is mandatory: silently treating historical periods as
   * open can corrupt a cutover even when every ledger balance matches.
   */
  accountingPeriods(): Promise<SourceEntity[]>;

  /** Cheap connectivity/credential probe for the "Test connection" button. */
  ping?(): Promise<{ ok: boolean; detail?: string }>;

  /**
   * The source's control accounts, by source ref. Used on a FRESH org (no
   * controlAccounts configured yet): after the entity streams load, the engine
   * resolves these refs to openbooks ids and writes org.settings.controlAccounts
   * so the posting rules route AR/AP/bank/tax exactly like the source did.
   */
  controlAccounts?(): Promise<Partial<Record<"ar" | "ap" | "bank" | "taxCollected" | "taxPaid", string>>>;

  /**
   * Master data, in dependency order (accounts, dimensions, parties, items…).
   * `since` lets high-volume streams (e.g. time entries) pull incrementally on a
   * mirror; low-volume master data may ignore it and return everything.
   */
  entities?(since?: Date | null): Promise<EntityStream[]>;

  /**
   * Small reference-data streams required to interpret a bounded transaction
   * pull exactly (for example connector tax-code identities). This must never
   * include high-volume operational streams such as parties or time entries.
   */
  transactionReferenceEntities?(): Promise<EntityStream[]>;

  /**
   * Native transactions created/modified after `since` (null = everything),
   * built against the provided context's id maps, plus the application graph.
   */
  nativeChanges(since: Date | null, ctx: NativeContext): Promise<NativeChanges>;

  /**
   * Optional governed repair pull for an explicit, bounded set of source
   * transaction references. The sync engine never advances the incremental
   * cursor from this operation and still runs every financial verification
   * gate after rematerialization.
   */
  nativeChangesByRefs?(
    sourceRefs: string[],
    ctx: NativeContext,
  ): Promise<NativeChanges>;

  /** Live per-account trial balance for verification after sync. */
  trialBalance(): Promise<SourceTrialBalanceRow[]>;

  /**
   * Per-account activity bucketed by posting MONTH ("YYYY-MM"). This is a
   * mandatory part of the connector contract for both full migrations and
   * mirrors: two ledgers can match all-time yet differ in period allocation
   * (a date-shifted posting nets out cumulatively but corrupts every monthly
   * P&L / balance sheet). Values are source-ledger home-currency amounts.
   */
  monthlyActivity(): Promise<SourceAccountMonthRow[]>;

  /** Ledger/book selected for authoritative verification, when applicable. */
  ledgerContext?(): Promise<SourceLedgerContext>;

  /**
   * Optional project-ledger verification capability. Connectors whose source
   * supports a project/job dimension return every posted project/account/month
   * bucket. When present, the sync engine treats this as a mandatory gate.
   */
  projectMonthlyActivity?(): Promise<SourceProjectAccountMonthRow[]>;

  /**
   * Optional complete commercial-state snapshot for project financials.
   * Connectors implement this when source billing disposition cannot be
   * reconstructed from migrated invoice-line links alone.
   */
  projectFinancialInputs?(): Promise<SourceProjectFinancialInputs>;

  /** Live per-document unpaid balances (AR/AP aging verification). */
  openItems?(): Promise<SourceOpenItem[]>;

  /** Release short-lived source material (for example raw bridge responses). */
  dispose?(): Promise<void>;
}
