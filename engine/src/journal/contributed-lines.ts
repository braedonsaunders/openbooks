/**
 * Contributed-line contract types: the shapes a journal-line contributor
 * (allocation rule, script, app, intercompany) adds to a posting
 * transaction's own journal entry. Owned by the journal kernel; the
 * allocations module re-exports them (its types.ts contract is FROZEN and
 * additive-only) so every existing importer keeps compiling.
 */

export type AllocationMode = "entry" | "post" | "period";
export type JournalLineContributorKind = "rule" | "script" | "app" | "intercompany";

/** A GL coordinate: account × dimensions × subsidiary. */
export interface Coordinate {
  accountId: string;
  subsidiaryId?: string | null;
  departmentId?: string | null;
  locationId?: string | null;
  classId?: string | null;
  projectId?: string | null;
  partyId?: string | null;
  extraDims?: Record<string, string>;
}

/** A line a contributor adds to a posting transaction's own journal entry. */
export interface ContributedLine extends Coordinate {
  /** Signed transaction-currency amount (debit +). */
  amount: string;
  currency?: string;
  memo?: string | null;
  contributorKind: JournalLineContributorKind;
  contributorRef: string;
  /** Non-primary posting book target; undefined = the primary book. */
  bookId?: string;
  lineage?: LineageDraft;
}

/** Lineage row before ids are known (journal line id is stamped after insert). */
export interface LineageDraft {
  mode: AllocationMode;
  ruleId: string;
  versionId: string;
  definitionHash: string;
  runId?: string | null;
  documentId?: string | null;
  sourceJournalLineId?: string | null;
  sourceDocumentLineId?: string | null;
  targetDocumentLineId?: string | null;
  /** Event trigger for event-bound post rules (the overhead net-zero pair): the approved time entry. */
  sourceTimeEntryId?: string | null;
  driverId?: string | null;
  driverValue?: string | null;
  driverTotal?: string | null;
  share?: string | null;
  amount: string;
  residual?: string;
}
