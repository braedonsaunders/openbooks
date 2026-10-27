import { guardRefusalMessage } from "../platform/database-refusal.ts";
export { guardRefusalMessage } from "../platform/database-refusal.ts";

/**
 * Staged sample-company provisioning failures.
 *
 * Every unexpected failure inside createSampleCompany is reported by the
 * pipeline STAGE that produced it — template generation, clone/copy of the
 * template's posted history, finalization, or document-numbering
 * reconciliation — with a stable machine-readable code and an
 * operator-facing message. The message is a fixed per-stage string: it never
 * carries SQL text, constraint names, or other internal detail — except a
 * deterministic guard refusal (Postgres P0001), whose guard-authored message
 * already names its remedy and replaces the generic stage guidance. The full
 * cause is logged server-side and kept on
 * `cause` for operators with log access, but it is never serialized to the
 * API response.
 *
 * Known validation refusals (unknown industry, no access to the source
 * organization) are NOT staged: they keep their specific messages and are
 * thrown before any stage runs.
 */
export class SampleCompanyError extends Error {
  // Typed as string (not the literal) so staged subclasses can narrow the
  // name to their own refusal without retyping the base.
  readonly name: string = "SampleCompanyError";
}

export type SampleCompanyProvisioningStage = "template" | "clone" | "finalize" | "numbering";

export const SAMPLE_COMPANY_STAGE_CODES: Record<SampleCompanyProvisioningStage, string> = {
  template: "sample-company-template-failed",
  clone: "sample-company-clone-failed",
  finalize: "sample-company-finalize-failed",
  numbering: "sample-company-numbering-failed",
};

const SAMPLE_COMPANY_STAGE_PHRASES: Record<SampleCompanyProvisioningStage, string> = {
  template: "preparing the verified template failed",
  clone: "copying the template's posted history failed",
  finalize: "finalizing the new company failed",
  numbering: "reconciling document numbering failed",
};

export function sampleCompanyStageMessage(stage: SampleCompanyProvisioningStage): string {
  return (
    `Sample company preparation stopped: ${SAMPLE_COMPANY_STAGE_PHRASES[stage]}. ` +
    "Company readiness is unconfirmed. Check Company Setup for an available sample company; if none is available, contact support before creating another copy."
  );
}

export class SampleCompanyProvisioningError extends SampleCompanyError {
  override readonly name = "SampleCompanyProvisioningError";
  readonly stage: SampleCompanyProvisioningStage;
  readonly code: string;

  constructor(
    stage: SampleCompanyProvisioningStage,
    options?: { cause?: unknown; message?: string },
  ) {
    super(options?.message ?? sampleCompanyStageMessage(stage), options);
    this.stage = stage;
    this.code = SAMPLE_COMPANY_STAGE_CODES[stage];
  }
}

/**
 * The API body for a staged provisioning failure: the stable machine code,
 * the stage, and the fixed operator-facing message. Safe to serialize
 * because the message is either the fixed per-stage string or a
 * guard-authored P0001 first line (see the module docstring) — never SQL
 * text, constraint names, or driver detail, which stay in the server log.
 * Lives here (not in the route) so the safety claim and the serialization
 * that relies on it change together.
 */
export function sampleCompanyProvisioningBody(error: SampleCompanyProvisioningError): {
  error: string;
  stage: SampleCompanyProvisioningStage;
  message: string;
} {
  return { error: error.code, stage: error.stage, message: error.message };
}

/**
 * The operator-facing outcome of a provisioning run that ended in a failure,
 * recorded where the operator reads progress. A staged failure carries its
 * stable code, stage and fixed message; a known refusal carries its specific
 * message (it names the condition and its remedy); anything else carries only
 * the support reference, so the reader shows the unconfirmed-readiness
 * guidance. The full cause stays in the server log under the same reference.
 */
export interface SampleCompanyFailureBody {
  error?: string;
  stage?: SampleCompanyProvisioningStage;
  message?: string;
  requestId: string;
}

export function sampleCompanyFailureBody(
  error: unknown,
  requestId: string,
): SampleCompanyFailureBody {
  if (error instanceof SampleCompanyProvisioningError) {
    return { ...sampleCompanyProvisioningBody(error), requestId };
  }
  if (error instanceof SampleCompanyError) return { message: error.message, requestId };
  return { requestId };
}

/**
 * A provisioning precondition that cannot proceed — e.g. a previous attempt
 * that could not be removed, so provisioning again would strand a second
 * org. Unlike unexpected stage failures these carry their specific message
 * (naming the stranded org and its remedy) past the stage wrapper:
 * relabelling them into the fixed per-stage string would hide both.
 */
export class SampleCompanyPreconditionError extends SampleCompanyError {
  override readonly name = "SampleCompanyPreconditionError";
}

/**
 * Run one provisioning stage, converting any unexpected failure into the
 * stage's named refusal. An already-staged refusal passes through untouched
 * so nested stages cannot relabel each other, as does a precondition refusal
 * whose specific message names a stranded org and its remedy. Any other
 * original error is logged with its full detail and retained as `cause`;
 * only the fixed per-stage message ever reaches the API body.
 */
export async function runProvisioningStage<T>(
  stage: SampleCompanyProvisioningStage,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SampleCompanyProvisioningError) throw error;
    if (error instanceof SampleCompanyPreconditionError) throw error;
    // A deterministic guard refusal names its remedy. The code stays the stable per-stage
    // code and the full cause stays server-side on `cause`.
    const refusal = guardRefusalMessage(error);
    console.error(`[sample-company] ${stage} stage failed`, error);
    throw new SampleCompanyProvisioningError(stage, {
      cause: error,
      ...(refusal !== undefined ? { message: refusal } : {}),
    });
  }
}
