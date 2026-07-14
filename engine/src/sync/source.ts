/**
 * MigrationSource — the adapter contract for pulling accounting data out of
 * an external system. Today: NetSuite (the temporary parallel-run bridge).
 * The same interface is the seed of one-click migration: implement an
 * adapter (QuickBooks Online, Xero, Sage, …), and the sync/migration engine,
 * TB verification, and UI come for free.
 */

export interface SourceGlLine {
  accountRef: string; // source system's account id
  amount: string; // signed: + debit / − credit (decimal string)
  departmentRef?: string | null;
  partyRef?: string | null;
}

export interface SourceTransaction {
  /** Stable id in the source system (drives idempotency + change detection). */
  sourceRef: string;
  type: string;
  number?: string | null;
  date: string; // ISO yyyy-mm-dd
  memo?: string | null;
  lines: SourceGlLine[];
}

export interface SourceChanges {
  transactions: SourceTransaction[];
  /** Source-clock high-water mark to persist for the next incremental pull. */
  syncedThrough: Date;
}

export interface SourceTrialBalanceRow {
  accountRef: string;
  balance: string; // signed decimal string, debit-positive
}

export interface MigrationSource {
  readonly name: string;
  /** Transactions created or modified after `since` (posted GL only). */
  changesSince(since: Date | null): Promise<SourceChanges>;
  /** Live per-account trial balance for verification after sync. */
  trialBalance(): Promise<SourceTrialBalanceRow[]>;
}
