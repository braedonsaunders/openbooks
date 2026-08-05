import type { EvalContext, FlowSubjectProfile } from "@openbooks/forms-core";

/**
 * The FlowSubjectAdapter seam — everything record-specific the flows engine
 * needs, behind one interface, so the ONE executor (execute.ts) can drive any
 * automatable record kind. The OpenBooks document vocabulary exposes a single
 * loadContext operation, status transitions (changeStatus), and whitelisted
 * header writes (setField).
 *
 * Adapters are pure server-side objects (no I/O at construction). They run in
 * whatever RLS scope the caller established (request org context at hook
 * sites, withOrg in the scheduler) — they never set scope themselves.
 */

/** Who is executing the flow (the hook site's request identity). */
export interface FlowExecCtx {
  orgId: string;
  /** The acting user when the event came from a request; absent for timers. */
  userId?: string | null;
}

/**
 * The subject's evaluation snapshot: `values` feeds EvalContext.values
 * (conditions + {{interpolation}} + `field` targets), `rows` feeds
 * EvalContext.rows (repeating data — document lines under the 'lines' key),
 * and `submitterUserId` backs the submitter/supervisor targets.
 */
export interface FlowSubjectContext {
  values: Record<string, unknown>;
  rows?: Record<string, Array<Record<string, unknown>>>;
  submitterUserId?: string | null;
}

export interface FlowSubjectAdapter {
  /** Subject discriminator this adapter instance serves (a document kind). */
  subjectKind: string;
  /** The author-time vocabulary for this subject (triggers/actions/fields). */
  profile: FlowSubjectProfile;
  /** Header fields a flow may persist into via set_field. */
  writableFields: Set<string>;
  /**
   * Some governed subjects never permit the submitter to decide a gate,
   * even when an authored gate opts out of the normal self-approval guard.
   * Period close uses this because independent approval is an accounting
   * invariant, not a tenant preference.
   */
  selfApprovalPolicy?: "configurable" | "forbidden";

  /** Load the record's evaluation snapshot; null when the record is gone. */
  loadContext(subjectId: string): Promise<FlowSubjectContext | null>;
  /** Short human label for notifications ("Vendor bill BILL-0042"). */
  label(subjectId: string, values: Record<string, unknown>): string;
  /** In-app link for notifications about this record. */
  deepLink(subjectId: string): string;

  /** Current lifecycle status (documents.status), null if the record is gone. */
  getStatus(subjectId: string): Promise<string | null>;
  /** change_status action — guards illegal transitions, throws on violation. */
  changeStatus(subjectId: string, to: string, ctx: FlowExecCtx): Promise<void>;
  /**
   * ENGINE-ENFORCED approval release. Called by decideGate once a subject's
   * approval fully resolves — `approved` when no gates remain open across all
   * runs, `rejected` when any gate rejected — so release is a deterministic
   * engine outcome, NOT an optional authored change_status side-effect. Must be
   * idempotent (a no-op when the record is no longer awaiting approval).
   * Optional: subjects without an approval lifecycle omit it.
   */
  releaseApproval?(
    subjectId: string,
    outcome: "approved" | "rejected",
    ctx: FlowExecCtx,
    detail?: { comment?: string | null },
  ): Promise<void>;
  /** set_field action — writableFields only, throws on violation. */
  setField(subjectId: string, field: string, value: unknown, ctx: FlowExecCtx): Promise<void>;
  /**
   * Recent candidate record ids for scheduled record fan-out (`scheduled`
   * triggers with a `select`). The scheduler loads each candidate's context
   * and evaluates the select rule in JS — this only needs to be a reasonable
   * coarse fetch (newest-first, excluding terminal records). Optional: subjects
   * without it don't support fan-out.
   */
  findCandidateIds?(limit: number): Promise<string[]>;
}

/** Build the EvalContext the planner/evaluator consume from a subject snapshot. */
export function toEvalContext(subject: FlowSubjectContext): EvalContext {
  return { values: subject.values, rows: subject.rows ?? {} };
}
