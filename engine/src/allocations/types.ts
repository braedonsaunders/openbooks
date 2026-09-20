/**
 * Allocation kernel — shared type contract.
 *
 * FROZEN by the coordinator for the build fleet: extend only additively
 * (new optional fields, new exported types). Every module under
 * engine/src/allocations/ and every web surface codes against these shapes.
 * Design: docs/design/allocation-kernel.md. Schema: schema/src/allocations.ts.
 *
 * Money is always a canonical decimal string handled by engine/src/money/money.ts
 * bigint helpers — never a JavaScript number.
 */

export type AllocationMode = "entry" | "post" | "period";
export type AllocationVersionStatus = "draft" | "published" | "retired";
export type AllocationBookScope = "primary" | "all_posting" | "books";
export type AllocationApplyPolicy = "automatic" | "suggest" | "manual";
export type AllocationSourceMeasure = "period_activity" | "period_end_balance" | "ytd_activity";
export type AllocationBasisKind = "fixed_percent" | "driver" | "stepped";
export type AllocationDriverAsOf = "period" | "document_date" | "prior_period";
export type AllocationTargetKind = "explicit" | "dynamic";
export type AllocationImpact = "reclass" | "net_zero_pair" | "report_only";
export type AllocationResidualPolicy = "largest_share" | "first_target" | "last_target" | "explicit_target";
export type AllocationSolveMethod = "sequential" | "simultaneous";
export type AllocationRunPolicy = "manual" | "auto_preview" | "auto_post";
export type AllocationDriverSourceKind =
  | "statistical_journal"
  | "gl_activity"
  | "gl_balance"
  | "native_measure"
  | "manual"
  | "report_definition";
export type AllocationRunStatus = "previewed" | "pending_approval" | "posted" | "reversed" | "failed" | "superseded";
export type AllocationRunTrigger = "manual" | "scheduled" | "close_automation" | "rerun";
export type JournalLineContributorKind = "rule" | "script" | "app" | "intercompany";

/** Built-in dimensions plus custom segments (`extra:<segmentKey>`). */
export type AllocationDimension =
  | "department"
  | "location"
  | "class"
  | "project"
  | "subsidiary"
  | `extra:${string}`;

export type AccountScope =
  | { kind: "any" }
  | { kind: "accounts"; accountIds: string[] }
  | { kind: "account_group"; dimension: string; groupKey: string };

export type UntaggableDimension = "department" | "location" | "class" | "project";

/** AND of present keys; an absent key matches anything. */
export interface DimensionFilters {
  departmentIds?: string[];
  locationIds?: string[];
  classIds?: string[];
  projectIds?: string[];
  subsidiaryIds?: string[];
  partyIds?: string[];
  itemIds?: string[];
  extraDims?: Record<string, string[]>;
  /** Match only lines with NO value in these dimensions. */
  requireUntagged?: UntaggableDimension[];
}

export interface DynamicTarget {
  dimension: AllocationDimension;
  include?: string[];
  exclude?: string[];
  /** Canonical decimal; targets with driver weight <= minWeight are skipped. Default "0". */
  minWeight?: string;
  /** null/undefined = keep the source account. */
  targetAccountId?: string | null;
}

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

/** What the matcher sees for one document line or kernel line. */
export interface LineCoordinate extends Coordinate {
  documentKind?: string | null;
  itemId?: string | null;
  /** Signed canonical decimal (debit +). */
  amount: string;
}

export interface AllocationRuleHead {
  id: string;
  orgId: string;
  key: string;
  name: string;
  description?: string | null;
  mode: AllocationMode;
  sortOrder: number;
  isActive: boolean;
  isSystem: boolean;
  currentVersionId?: string | null;
}

export interface AllocationRuleTarget {
  id?: string;
  sequence: number;
  targetAccountId?: string | null;
  departmentId?: string | null;
  locationId?: string | null;
  classId?: string | null;
  projectId?: string | null;
  subsidiaryId?: string | null;
  extraDims?: Record<string, string>;
  /** Canonical decimal percent (0 < p <= 100) for fixed_percent basis. */
  fixedPercent?: string | null;
  /** Canonical decimal manual weight (>= 0). */
  weight?: string | null;
  isRemainder?: boolean;
  label?: string | null;
}

export interface AllocationRuleVersion {
  id: string;
  orgId: string;
  ruleId: string;
  versionNo: number;
  status: AllocationVersionStatus;
  effectiveFrom: string;
  effectiveTo?: string | null;
  bookScope: AllocationBookScope;
  bookIds: string[];
  documentKinds?: string[] | null;
  accountScope: AccountScope;
  dimensionFilters: DimensionFilters;
  applyPolicy: AllocationApplyPolicy;
  sourceMeasure: AllocationSourceMeasure;
  basisKind: AllocationBasisKind;
  driverId?: string | null;
  driverAsOf: AllocationDriverAsOf;
  basisConfig: Record<string, unknown>;
  targetKind: AllocationTargetKind;
  dynamicTarget: Partial<DynamicTarget>;
  impact: AllocationImpact;
  offsetAccountId?: string | null;
  residualPolicy: AllocationResidualPolicy;
  residualTargetId?: string | null;
  solveMethod: AllocationSolveMethod;
  runPolicy: AllocationRunPolicy;
  runOffsetDays: number;
  approvalFlowId?: string | null;
  memoTemplate?: string | null;
  lineDescriptionTemplate?: string | null;
  definitionHash?: string | null;
  publishedAt?: string | Date | null;
  publishedBy?: string | null;
}

/** A rule head + the version in force for a given date, with its targets. */
export interface RuleInEffect {
  rule: AllocationRuleHead;
  version: AllocationRuleVersion;
  targets: AllocationRuleTarget[];
}

export interface AllocationDriver {
  id: string;
  orgId: string;
  key: string;
  name: string;
  description?: string | null;
  /** Revision token for updates (ISO timestamp of the row). */
  updatedAt?: string | null;
  unit?: string | null;
  dimension: AllocationDimension;
  sourceKind: AllocationDriverSourceKind;
  config: Record<string, unknown>;
  isActive: boolean;
}

/** dimension value id → canonical decimal weight (>= 0). */
export type DriverVector = Map<string, string>;

export type DriverAsOf = { periodId: string } | { date: string };

export interface DriverResolveRequest {
  orgId: string;
  driver: AllocationDriver;
  asOf: DriverAsOf;
  /** Restrict the vector to these dimension values (dynamic include/explicit targets). */
  include?: string[];
  exclude?: string[];
  subsidiaryId?: string | null;
  /** Actor whose permissions govern report-backed drivers. */
  actorId?: string | null;
}

export interface DriverResolver {
  resolve(request: DriverResolveRequest): Promise<DriverVector>;
  /**
   * The same resolution plus the temporal contract behind a report-backed
   * vector (null for every other source kind). Optional so existing test
   * doubles keep working; production resolvers implement it.
   */
  resolveWithTemporal?(request: DriverResolveRequest): Promise<{
    vector: DriverVector;
    temporal: ReportDriverTemporal | null;
  }>;
}

/** What the requested period means for a `report_definition` driver. */
export type ReportTemporalMode = "period_activity" | "balance_as_of" | "fixed_query";

/** The temporal contract a report-backed driver actually enforced. */
export interface ReportDriverTemporal {
  mode: ReportTemporalMode;
  /** Window start (period_activity only; the other modes bind no window). */
  from: string | null;
  /** Window/snapshot end (null for fixed_query, which binds no period). */
  to: string | null;
  /** The report date column the window bound (period_activity only). */
  field: string | null;
}

/** One weighted target ready for apportionment. */
export interface WeightedTarget {
  /** Stable key (target id or dimension value id). */
  key: string;
  /** Canonical decimal weight (>= 0). */
  weight: string;
  isRemainder?: boolean;
}

export interface ApportionedTarget {
  key: string;
  weight: string;
  /** Canonical decimal share in [0,1], 10 dp. */
  share: string;
  /** Canonical money, same sign as the total. */
  amount: string;
  /** Money placed here by the residual policy (0 for all but one target). */
  residual: string;
}

export interface ApportionResult {
  total: string;
  weightTotal: string;
  targets: ApportionedTarget[];
  /** Key of the target that absorbed the residual, if any. */
  residualKey?: string | null;
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

export interface MatchResult {
  matched: boolean;
  /** How many predicates were present and matched (specificity). */
  specificity: number;
}

/** Explain payload stored in allocation_runs.computation. */
export interface RunComputation {
  ruleId: string;
  versionId: string;
  definitionHash: string;
  periodId: string;
  bookId: string;
  subsidiaryId?: string | null;
  sourceMeasure: AllocationSourceMeasure;
  sources: Array<Coordinate & { amount: string; lineCount: number }>;
  sourceTotal: string;
  driver?: {
    id: string;
    key: string;
    asOf: DriverAsOf;
    vector: Array<{ key: string; value: string }>;
    /** The enforced temporal contract (report drivers only; see allocationFingerprint). */
    temporal?: ReportDriverTemporal | null;
  } | null;
  targets: Array<
    ApportionedTarget & {
      coordinate: Coordinate;
      label?: string | null;
    }
  >;
  lines: Array<ContributedLine & { lineNumber: number }>;
  residualPolicy: AllocationResidualPolicy;
  impact: AllocationImpact;
}
