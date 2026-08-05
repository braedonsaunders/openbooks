/**
 * Accounting-standards conformance corpus — type contract.
 *
 * Each case encodes ONE requirement of a published accounting standard as an
 * executable fixture: stated facts, a citation an accountant can look up in
 * their own copy of the standard, and the exact accounting outcome the product
 * must produce. The runner drives real product code and diffs the result.
 *
 * Two rules make this evidence rather than decoration:
 *
 *  1. NO TOLERANCE. Amounts are compared as exact 4dp decimal strings. A
 *     hundredth of a cent is a failure.
 *  2. NO IMPLICIT PASS. A requirement the product does not implement is
 *     declared with `support: "not-implemented"` and reported as a GAP. It is
 *     never omitted from the register and never counted as passing. The same
 *     rule the ledger-parity harness applies to capability coverage.
 *
 * Copyright note: the standards themselves are copyrighted works. This corpus
 * contains NO text from any standard. Each case states the requirement in our
 * own words, cites the paragraph, and encodes numeric facts (which are not
 * themselves the copyrighted expression). Verify a case by reading the cited
 * paragraph in an authoritative copy.
 */

/** Standards bodies' documents this corpus draws requirements from. */
export type Standard =
  | "ASC 330"
  | "ASC 360"
  | "ASC 606"
  | "ASC 740"
  | "ASC 842"
  | "IAS 2"
  | "IAS 12"
  | "IAS 16"
  | "IAS 21"
  | "IAS 36"
  | "IFRS 15"
  | "IFRS 16";

/**
 * How the case relates to its source.
 *
 * `requirement` — the case is constructed by us to exercise the rule stated in
 * the cited paragraph. This is the honest default: it claims only that the
 * paragraph says what our `requirement` line says it says.
 *
 * `illustrative-example` — the case follows a worked example published inside
 * the standard. Used sparingly, and only where the example is unambiguous.
 */
export type CitationKind = "requirement" | "illustrative-example";

export interface Citation {
  standard: Standard;
  /** Paragraph or example reference, e.g. "606-10-32-31" or "IFRS 15.73". */
  reference: string;
  kind: CitationKind;
  /**
   * The requirement RESTATED IN OUR OWN WORDS — never the standard's text.
   * One sentence. This is what the case actually asserts.
   */
  requirement: string;
}

/**
 * Conformance disposition. Mirrors the ledger-parity harness's exhaustiveness
 * doctrine: everything is classified, nothing is silently dropped.
 *
 * `supported`       — product code implements the requirement directly.
 * `semantic`        — product reaches the required accounting outcome through a
 *                     different mechanism than the standard's own framing.
 * `partial`         — product implements part of the requirement; the shortfall
 *                     is recorded in `limitation` and the case asserts only the
 *                     part that is implemented.
 * `not-implemented` — declared gap. Reported as GAP. Never a pass.
 */
export type Support = "supported" | "semantic" | "partial" | "not-implemented";

/**
 * `computation` cases exercise pure functions and need no database — they run
 * in the unit CI job. `ledger` cases post real documents through the kernel and
 * read journal_lines back; they need PostgreSQL and self-skip without it.
 */
export type Tier = "computation" | "ledger";

/**
 * Semantic account roles. The corpus asserts on ROLES, never on chart-of-
 * accounts numbers, so a case stays valid across every industry COA preset.
 * The role→account binding lives in roles.ts.
 */
export type Role =
  // Working capital
  | "ar"
  | "ap"
  | "bank"
  // Revenue
  | "revenue"
  | "deferredRevenue"
  | "recognizedRevenue"
  | "contractAsset"
  // Inventory
  | "inventory"
  | "cogs"
  | "inventoryAdjustment"
  | "inventoryClearing"
  | "freight"
  // Indirect tax (bound so that any posting the corpus triggers resolves to a
  // role; an unbound account is a loud failure, not a silent omission)
  | "taxRecoverable"
  | "taxPayable"
  | "withholdingPayable"
  // Long-lived assets
  | "fixedAsset"
  | "accumulatedDepreciation"
  | "impairmentLoss"
  | "disposalGainLoss"
  // Foreign currency
  | "fxRealizedGainLoss"
  | "fxUnrealizedGainLoss"
  | "loanPayable"
  // Income tax
  | "incomeTaxExpense"
  | "incomeTaxPayable"
  | "deferredTaxAsset"
  | "deferredTaxLiability"
  // Leases (declared for the not-implemented lease cases)
  | "rouAsset"
  | "leaseLiability"
  | "leaseExpense"
  | "leaseInterestExpense"
  | "rouAmortization";

/** A signed ledger line. Positive = debit, negative = credit. Always 4dp. */
export interface ExpectedLine {
  role: Role;
  amount: string;
}

/** One journal entry the case expects, labelled by the step that produced it. */
export interface ExpectedEntry {
  /** Business step, e.g. "invoice" or "month 1 recognition". */
  step: string;
  lines: ExpectedLine[];
}

/**
 * The outcome of a case: journal entries, named scalar figures, or both. Some
 * requirements (allocation splits, provision figures, schedule amounts) are
 * about numbers that are not themselves a journal entry.
 */
export interface Outcome {
  entries?: ExpectedEntry[];
  /** Named exact figures, e.g. { "po1": "33.3333", "sum": "100.0000" }. */
  values?: Record<string, string>;
}

/** Raw lines a case's `run` returns; the runner maps accountId → role. */
export interface ActualLine {
  accountId: string;
  amount: string;
}

export interface ActualEntry {
  step: string;
  lines: ActualLine[];
}

export interface ActualOutcome {
  entries?: ActualEntry[];
  values?: Record<string, string>;
}

/** Everything a case's `run` needs. `roles` resolves a Role to an account id. */
export interface CaseContext {
  /** Role → account id. Synthetic for computation cases, real for ledger. */
  roles: Record<Role, string>;
  /** Present only for `ledger` cases. */
  ledger?: LedgerContext;
}

export interface LedgerContext {
  orgId: string;
  subsidiaryId: string;
  bookId: string;
  periodId: string;
  stockLocationId: string;
  customerId: string;
  vendorId: string;
  actorId: string;
  /** A date inside the open period. */
  date: string;
  items: Record<"fifo" | "movingAvg" | "standard" | "service", string>;
}

export interface ConformanceCase {
  /** Stable slug; appears in the published matrix. Never renumber. */
  id: string;
  title: string;
  citations: Citation[];
  support: Support;
  tier: Tier;
  /**
   * What an accountant learns if this passes. Written for a controller, not an
   * engineer — this text goes straight into the published matrix.
   */
  assertion: string;
  /** The scenario's facts, in our own words. Numbers live here. */
  facts: string[];
  /** Required when support is "partial" — what the product does NOT do. */
  limitation?: string;
  /** Required when support is "not-implemented" — what is missing. */
  gap?: string;
  /** The expected outcome. Present even for gaps: it is the target. */
  expected: Outcome;
  /** Omitted for "not-implemented" cases. */
  run?: (ctx: CaseContext) => Promise<ActualOutcome> | ActualOutcome;
}

export type CaseStatus = "pass" | "fail" | "gap" | "skipped";

export interface Difference {
  /** Where the mismatch is, e.g. `entry "invoice" role ar` or `value po1`. */
  at: string;
  expected: string;
  actual: string;
}

export interface CaseResult {
  case: ConformanceCase;
  status: CaseStatus;
  differences: Difference[];
  /** Set when the case threw. */
  error?: string;
  ms: number;
}

export interface CorpusReport {
  /** Caller-supplied ISO timestamp — the engine never reads the clock itself. */
  at: string;
  gitSha: string | null;
  results: CaseResult[];
  totals: Record<CaseStatus, number>;
  /** True only when there are zero failures. Gaps do not fail the corpus; they
   *  are published. A gap that regresses to a wrong answer becomes a failure. */
  pass: boolean;
}
