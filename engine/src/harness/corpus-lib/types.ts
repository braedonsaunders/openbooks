/**
 * Neutral, product-independent event schema shared by the differential-corpus
 * harness (engine/src/harness/differential) and the public replay harness
 * (engine/src/harness/replay).
 *
 * Design contract:
 *  - Every amount is an exact decimal string. Journals carry SIGNED amounts
 *    (debit positive, credit negative) that sum to zero. Commercial documents
 *    (invoices/bills/credits) carry POSITIVE line amounts; the debit/credit
 *    direction is a fixed, documented function of the document kind (see
 *    reference-ledger.ts and the README) so any accounting system can replay
 *    the corpus without OpenBooks-specific knowledge.
 *  - Accounts and parties are referenced by stable semantic keys, never by
 *    generated ids, so snapshots are comparable across systems.
 *  - Payment allocations reference the target commercial event by its event id.
 */

export interface CorpusAccount {
  key: string;
  number: string;
  name: string;
  /** OpenBooks account_type enum value (documented; other systems map by class). */
  type: string;
}

export type CorpusPartyRole = "customer" | "vendor" | "employee";

export interface CorpusParty {
  key: string;
  name: string;
  roles: CorpusPartyRole[];
}

export interface CorpusProject {
  key: string;
  name: string;
  /** OpenBooks project-type key (e.g. time_and_materials, schedule_of_values). */
  method: string;
  customer: string;
  contractValue?: string;
  sovLines?: { description: string; scheduledValue: string }[];
}

export interface CorpusDocLine {
  /** Semantic account key. */
  account: string;
  /** Positive decimal amount (commercial docs) or signed amount (journals). */
  amount: string;
  description?: string;
  /** Semantic project key (job costing dimension), if tagged. */
  project?: string | null;
}

export type CommercialKind =
  | "customer_invoice"
  | "customer_credit"
  | "vendor_bill"
  | "vendor_credit"
  | "expense_report";

export interface JournalEvent {
  id: string;
  kind: "journal";
  date: string;
  memo?: string;
  /** Signed lines (debit +, credit −); must sum to zero. */
  lines: CorpusDocLine[];
}

export interface CommercialEvent {
  id: string;
  kind: CommercialKind;
  date: string;
  dueDate?: string | null;
  party: string;
  memo?: string;
  /** Positive line amounts; direction is a function of `kind`. */
  lines: CorpusDocLine[];
}

export interface PaymentEvent {
  id: string;
  kind: "customer_payment" | "vendor_payment";
  date: string;
  party: string;
  memo?: string;
  /** Each allocation settles part of a prior commercial event's open balance. */
  allocations: { event: string; amount: string }[];
}

export type CorpusEvent = JournalEvent | CommercialEvent | PaymentEvent;

export interface Corpus {
  schemaVersion: 1;
  name: string;
  seed: string;
  currency: string;
  country: string;
  /** Inclusive window (YYYY-MM-DD); the replayer provisions one period per month. */
  startDate: string;
  endDate: string;
  accounts: CorpusAccount[];
  parties: CorpusParty[];
  projects?: CorpusProject[];
  /** Chronologically ordered (stable within a day by id). */
  events: CorpusEvent[];
}

/** The cross-system comparison contract computed from a corpus. */
export interface ExpectedBalances {
  schemaVersion: 1;
  corpus: string;
  seed: string;
  /** Signed (debit-positive) balance per semantic account key; zeros omitted. */
  trialBalance: Record<string, string>;
  /** Signed open balance per party per subledger side; zeros omitted. */
  openBalances: Record<string, { ar?: string; ap?: string }>;
  eventCount: number;
}
