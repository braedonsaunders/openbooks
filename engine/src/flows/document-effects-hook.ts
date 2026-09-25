import type { FlowExecCtx } from "./types.ts";

/**
 * Document effects port for flow posting and void completion
 * (ARCH-MODULE-CYCLE C14).
 *
 * GL posting (postDocument, postPaymentWithApplications) and requested-void
 * completion live in ledger/payments — layers the flows orchestrator cannot
 * import without cycling. The composition root registers the real effects
 * via installEngineSeams; the executor (post_document action) and the
 * documents adapter (before_void releaseApproval branch) call whatever is
 * installed. The port is invoked inline in the same async call chain, so
 * the ambient pinned org transaction that `db` routes to does not change.
 *
 * Missing effects throw instead of no-op-ing: a silent no-op here would
 * report an approval or posting as done while writing nothing.
 */
export interface FlowDocumentEffects {
  /** Post a subject and return the GL entry id (post_document action). */
  postSubject(args: {
    subjectKind: string;
    subjectId: string;
    ctx: FlowExecCtx;
  }): Promise<string>;
  /** Complete an approved requested void on a posted/approved document. */
  completeRequestedVoid(
    subjectId: string,
    orgId: string,
    allowedSubsidiaryIds?: ReadonlySet<string> | null,
  ): Promise<void>;
  /** Reject a requested void, parking the document back with a comment. */
  rejectRequestedVoid(
    subjectId: string,
    orgId: string,
    userId: string | null,
    comment: string | null,
  ): Promise<void>;
}

/** Thrown when document effects are used without an installed port. */
export class FlowDocumentEffectsNotInstalledError extends Error {
  constructor() {
    super(
      "flow document effects are not installed in this process; " +
        "call installEngineSeams() at process boot (engine) " +
        "— web installs it beside the web handlers in instrumentation",
    );
    this.name = "FlowDocumentEffectsNotInstalledError";
  }
}

let effects: FlowDocumentEffects | null = null;

export function registerFlowDocumentEffects(
  next: FlowDocumentEffects,
): void {
  effects = next;
}

/** The installed document effects, or a named throw when missing. */
export function flowDocumentEffects(): FlowDocumentEffects {
  if (!effects) throw new FlowDocumentEffectsNotInstalledError();
  return effects;
}
