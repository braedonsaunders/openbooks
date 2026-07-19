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

/** A source settlement link: payment/credit → the open item it settled. */
export interface SourceApplicationLink {
  paymentRef: string;
  appliedRef: string;
  amount: string;
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
  amount: string; // signed decimal string, debit-positive, in home currency
}

/** Source ground truth for one open item (invoice/bill): remaining unpaid. */
export interface SourceOpenItem {
  ref: string;
  unpaid: string;
}

// --- The adapter -----------------------------------------------------------------

export interface MigrationSource {
  readonly name: string;
  /** Key under which source ids live in each row's `custom` jsonb (e.g. "nsId"). */
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
   * Native transactions created/modified after `since` (null = everything),
   * built against the provided context's id maps, plus the application graph.
   */
  nativeChanges(since: Date | null, ctx: NativeContext): Promise<NativeChanges>;

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

  /** Live per-document unpaid balances (AR/AP aging verification). */
  openItems?(): Promise<SourceOpenItem[]>;

  /** Release short-lived source material (for example raw bridge responses). */
  dispose?(): Promise<void>;
}
